// SPDX-License-Identifier: Apache-2.0
// admin/cra/cra-patcher.js — LLM-basierte Patch-Generierung (CommonJS)
// Least-Cost: Groq → Gemini → Anthropic. Cross-Model-Review.
var fs = require('fs');
var path = require('path');
var child = require('child_process');
var llm = require('../lib/llm'); // LLM-Abstraktion (CRA Plus bindet via MERIDIAN_LLM_ADAPTER opsdesk an)
var https = require('https');

var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

// Dateien die NIEMALS geändert werden dürfen
var BLACKLIST = ['.env', '.env.local', '.env.production', 'credentials.json', 'serviceAccountKey.json'];
var BLACKLIST_EXT = ['.pem', '.key', '.p12', '.pfx'];

// ── Relevante Dateien für ein Finding lesen ─────────────────────────

function loadContext(repoDir, finding) {
  var candidateFiles = [];

  // Strategie 1: Dateinamen aus Description extrahieren
  // - Alternation-Reihenfolge (json|html|css|js): längere zuerst, sonst matcht JS-Regex
  //   ".js" in "package.json" bevor ".json" geprüft wird → Kandidat "package.js" existiert nicht.
  // - Absolute Pfade (Prod-Pfade aus Enricher) verwerfen — im Staging-Repo nicht auflösbar.
  // - Nur existente Kandidaten behalten, sonst blockieren nicht-gefundene Treffer die Fallbacks.
  if (finding.description) {
    var fileMatches = finding.description.match(/[\w\-./]+\.(json|html|css|js)/g) || [];
    fileMatches = fileMatches
      .filter(function(m) { return !path.isAbsolute(m); })
      .filter(function(m) { return fs.existsSync(path.join(repoDir, m)); });
    candidateFiles = candidateFiles.concat(fileMatches);
  }

  // Strategie 2: Kategorie-basierte Defaults
  if (!candidateFiles.length) {
    var cat = (finding.category || '').toLowerCase();
    if (cat === 'dependency') {
      candidateFiles.push('package.json');
    } else if (cat === 'security' || cat === 'secret' || cat === 'auth') {
      // Hauptdatei(en) des Repos finden — inkl. Monorepo-Subpfade (backend/, src/, api/)
      var mainFiles = [
        'src/server.js', 'server.js', 'admin/server.js', 'app.js', 'index.js',
        'backend/server.js', 'backend/src/server.js', 'backend/app.js', 'backend/index.js',
        'api/server.js', 'api/index.js'
      ];
      mainFiles.forEach(function(f) {
        if (fs.existsSync(path.join(repoDir, f))) candidateFiles.push(f);
      });
    } else if (cat === 'quality') {
      // grep im Repo nach dem Pattern aus dem Titel
      candidateFiles = grepForPattern(repoDir, finding);
    }
  }

  // Strategie 3: Wenn immer noch leer → grep nach Schlüsselwörtern aus dem Titel
  if (!candidateFiles.length) {
    candidateFiles = grepForPattern(repoDir, finding);
  }

  // Strategie 4: Letzter Fallback → Hauptdatei des Repos
  if (!candidateFiles.length) {
    var fallbacks = ['src/server.js', 'server.js', 'admin/server.js', 'app.js', 'index.js', 'package.json'];
    fallbacks.forEach(function(f) {
      if (fs.existsSync(path.join(repoDir, f))) candidateFiles.push(f);
    });
  }

  // Deduplizieren
  var seen = {};
  candidateFiles = candidateFiles.filter(function(f) {
    if (seen[f]) return false;
    seen[f] = true;
    return true;
  });

  // Dateien lesen (max 5). Dateien bis 1000 Zeilen vollstaendig mitgeben — vermeidet
  // dass das LLM "old"-Strings halluziniert, weil es Teile der Datei nicht gesehen hat.
  // Context-Kosten sind vertretbar (Haiku 200k Fenster, Prompt Caching greift).
  var files = [];
  candidateFiles.slice(0, 5).forEach(function(relPath) {
    var fullPath = path.resolve(repoDir, relPath);
    if (!fs.existsSync(fullPath)) return;
    if (!fullPath.startsWith(path.resolve(repoDir))) return; // Path Traversal

    var basename = path.basename(relPath);
    if (BLACKLIST.indexOf(basename) >= 0) return;
    if (BLACKLIST_EXT.some(function(ext) { return basename.endsWith(ext); })) return;

    try {
      var content = fs.readFileSync(fullPath, 'utf8');
      var lines = content.split('\n');
      if (lines.length > 1000) {
        var relevant = extractRelevantLines(lines, finding);
        files.push({ path: relPath, content: relevant, truncated: true, totalLines: lines.length });
      } else {
        files.push({ path: relPath, content: content, truncated: false, totalLines: lines.length });
      }
    } catch(e) { /* Lesefehler ignorieren */ }
  });

  return files;
}

// ── Grep im Repo nach Schlüsselwörtern aus Finding ──────────────────

function grepForPattern(repoDir, finding) {
  var keywords = (finding.title || '').split(/[\s():,]+/).filter(function(w) {
    return w.length > 4 && !/^(fuer|eine|wird|nicht|oder|und|mit|von|aus|bei|nach|über)$/i.test(w);
  });
  if (!keywords.length) return [];

  var pattern = keywords[0];
  try {
    var result = child.execSync(
      'rg -l --glob "*.js" --glob "!node_modules" --glob "!.git" '
      + JSON.stringify(pattern) + ' ' + JSON.stringify(repoDir)
      + ' 2>/dev/null | head -5',
      { encoding: 'utf8', timeout: 5000 }
    );
    if (result && result.trim()) {
      return result.trim().split('\n').map(function(f) {
        return f.replace(repoDir + '/', '').replace(repoDir, '');
      });
    }
  } catch(e) { /* ignore */ }
  return [];
}

function extractRelevantLines(lines, finding) {
  // Versuche das Pattern aus dem Finding im Code zu finden
  var patternStr = finding.title || '';
  var keywords = patternStr.split(/[\s()]+/).filter(function(w) { return w.length > 3; });

  for (var i = 0; i < lines.length; i++) {
    for (var k = 0; k < keywords.length; k++) {
      if (lines[i].indexOf(keywords[k]) >= 0) {
        // 100 Zeilen vor + 100 nach dem Treffer (genug Kontext fuer exaktes "old"-Match)
        var start = Math.max(0, i - 100);
        var end = Math.min(lines.length, i + 100);
        return lines.slice(start, end).map(function(l, idx) {
          return (start + idx + 1) + ': ' + l;
        }).join('\n');
      }
    }
  }

  // Kein Treffer: erste 300 Zeilen
  return lines.slice(0, 300).map(function(l, idx) {
    return (idx + 1) + ': ' + l;
  }).join('\n');
}

// ── LLM-Prompt für Patch-Generierung ────────────────────────────────

function buildPatchPrompt(finding, files) {
  var filesStr = files.map(function(f) {
    return '=== ' + f.path + ' (' + f.totalLines + ' Zeilen' + (f.truncated ? ', Ausschnitt' : '') + ') ===\n' + f.content;
  }).join('\n\n');

  var isDep = (finding.category || '').toLowerCase() === 'dependency';
  var intro = isDep
    ? 'Du bist ein Node.js DevOps Engineer. Es gibt eine npm Dependency-Vulnerability. Aktualisiere die betroffene Dependency in package.json auf eine sichere Version. Wenn die Vulnerability durch eine transitive Dependency kommt, fuege ein "overrides"-Feld hinzu.\n\n'
    : 'Du bist ein erfahrener Node.js Security Engineer fuer das kurven.schule Oekosystem. Fixe das folgende Finding mit der minimalen, korrekten Aenderung.\n\n';

  // STATISCHER PROMPT-TEIL (Ziel: >= 1024 Tokens fuer effektives Anthropic Prompt Caching)
  var staticContext = intro
    + '## Stack-Kontext\n'
    + '- Node.js 22.x, CommonJS (require); manche Apps bereits ES Modules (import/export)\n'
    + '- Express REST APIs mit Token- oder Session-Auth (SSO via KS_SSO_SECRET)\n'
    + '- SQLite via better-sqlite3 (neu) oder sql.js (Legacy, in-memory + manual save)\n'
    + '- Tests: node:test oder bash-Scripts unter /opt/ks-management/*-test.sh\n'
    + '- App-User laufen unter eigenen Linux-Usern, nicht root\n'
    + '- DBs liegen in /var/lib/<app>/ (wegen clp-agent-Integration)\n'
    + '\n## Fix-Prinzipien (streng befolgen)\n'
    + '1. Minimal: nur die fehlerhafte(n) Zeile(n) ersetzen\n'
    + '2. Kein Refactoring, keine Stil-Anpassungen, keine Import-Reorganisierung\n'
    + '3. Keine neuen npm-Dependencies ohne zwingenden Grund\n'
    + '4. Niemals .env, credentials.json, *.pem, *.key anfassen\n'
    + '5. SQL: Prepared Statements (Named- oder Positional-Parameter), niemals String-Concatenation\n'
    + '6. HTML-Ausgabe: textContent statt innerHTML, oder dokumentierte Escape-Helper\n'
    + '7. User-Input: an System-Boundary validieren (Request-Handler), intern vertrauen\n'
    + '8. Bei sql.js: beachte dass INSERTs nur nach saveDb() auf Disk landen (kein Auto-Persist)\n'
    + '9. Bei undefined: auf null normalisieren bevor DB-Binding\n'
    + '\n## Beispiel 1 — SQL Injection\n'
    + 'Finding: "User-Input in SQL-Query konkateniert (SQL Injection moeglich)"\n'
    + 'Schlecht: `db.prepare("SELECT * FROM users WHERE id = " + userId).get()`\n'
    + 'Gut:     `db.prepare("SELECT * FROM users WHERE id = ?").get(userId)`\n'
    + '\n## Beispiel 2 — XSS via innerHTML\n'
    + 'Finding: "Unescaped User-Content in DOM-Manipulation"\n'
    + 'Schlecht: `el.innerHTML = userComment`\n'
    + 'Gut:     `el.textContent = userComment`\n'
    + '\n## Beispiel 3 — Path Traversal\n'
    + 'Finding: "User-Parameter in fs.readFile ohne Normalisierung"\n'
    + 'Schlecht: `fs.readFile("/data/" + req.params.file, ...)`\n'
    + 'Gut:\n'
    + '```\n'
    + 'var safe = path.resolve("/data", req.params.file);\n'
    + 'if (!safe.startsWith(path.resolve("/data") + path.sep)) return res.status(400).end();\n'
    + 'fs.readFile(safe, ...);\n'
    + '```\n'
    + '\n## Beispiel 4 — Hardcoded Secret\n'
    + 'Finding: "API-Key im Code"\n'
    + 'Schlecht: `var apiKey = "sk-ant-..."`\n'
    + 'Gut:     `var apiKey = process.env.ANTHROPIC_API_KEY;`\n'
    + '\n## Antwort-Format (STRICT JSON)\n'
    + 'Antworte NUR mit validem JSON. Kein Markdown, kein Text davor/danach.\n'
    + '```\n'
    + '{\n'
    + '  "changes": [\n'
    + '    {\n'
    + '      "file": "pfad/zur/datei.js",\n'
    + '      "old": "exakter Original-Code der ersetzt werden soll",\n'
    + '      "new": "neuer Code der den alten ersetzt"\n'
    + '    }\n'
    + '  ],\n'
    + '  "explanation": "Was wurde geaendert und warum (1-2 Saetze)"\n'
    + '}\n'
    + '```\n'
    + '\n## Regeln fuer "old" und "new"\n'
    + '- "old" muss EXAKT im Original vorkommen (copy-paste inkl. Whitespace, Einrueckung)\n'
    + '- "new" ersetzt "old" 1:1 an dieser Position\n'
    + '- Mehrere getrennte Aenderungen pro Datei -> mehrere Eintraege im changes-Array\n'
    + '- "old" darf nicht leer sein (kein reiner Insert)\n'
    + '- "old" muss im File eindeutig sein, sonst greift only first-match\n'
    + '- Keine Path-Traversal-Pfade ("..") in "file"\n'
    + '- Pfade relativ zum Repo-Root, nicht absolute\n';

  // DYNAMISCHER TEIL — hinter '## Finding' Marker (wird in anthropicPatch gesplittet)
  return staticContext
    + '\n## Finding\n'
    + 'ID: ' + (finding.id || '-') + '\n'
    + 'Severity: ' + (finding.severity || '-') + '\n'
    + 'Kategorie: ' + (finding.category || '-') + '\n'
    + 'Titel: ' + (finding.title || '-') + '\n'
    + 'Beschreibung: ' + (finding.description || '-') + '\n'
    + (finding.fix ? 'Vorgeschlagener Fix: ' + finding.fix + '\n' : '')
    + '\n## Betroffene Dateien\n' + filesStr;
}

// ── Pipeline-Prompts fuer Patch-Generierung ────────────────────────

function buildPatchAnalysePrompt(finding) {
  return 'Analysiere dieses Security/Code Finding. Identifiziere was genau gefixt werden muss.\n' +
    'Antworte NUR mit JSON:\n' +
    '{"root_cause":"Kernursache in 1 Satz",' +
    '"fix_strategy":"Wie soll der Fix aussehen (1-2 Saetze)",' +
    '"target_patterns":["Code-Muster die gesucht werden muessen"],' +
    '"risk":"low|medium|high",' +
    '"needs_test":true|false}\n\n' +
    'Finding:\n' +
    'ID: ' + (finding.id || '-') + '\n' +
    'Severity: ' + (finding.severity || '-') + '\n' +
    'Kategorie: ' + (finding.category || '-') + '\n' +
    'Titel: ' + (finding.title || '-') + '\n' +
    'Beschreibung: ' + (finding.description || '-') + '\n' +
    (finding.fix ? 'Vorgeschlagener Fix: ' + finding.fix + '\n' : '');
}

function buildPatchKontextPrompt(finding, files) {
  var filesStr = files.map(function(f) {
    return '=== ' + f.path + ' (' + f.totalLines + ' Z) ===\n' + f.content.substring(0, 2000);
  }).join('\n\n');

  return 'Analysiere den Code-Kontext fuer dieses Finding. Fokus: Welche Stellen muessen geaendert werden?\n' +
    'Antworte NUR mit JSON:\n' +
    '{"affected_files":[{"file":"...","line_hint":"...","what":"was muss sich aendern"}],' +
    '"similar_patterns":["Gibt es aehnliche Stellen die auch gefixt werden muessen?"],' +
    '"dependencies":["Welche anderen Dateien koennten betroffen sein?"],' +
    '"caution":"Worauf muss man achten?"}\n\n' +
    'Finding: ' + (finding.title || '-') + ' (' + (finding.severity || '-') + ')\n' +
    (finding.description || '') + '\n\n' +
    'Code:\n' + filesStr;
}

function buildPatchGenPrompt(finding, files, analyseResult, kontextResult) {
  var filesStr = files.map(function(f) {
    return '=== ' + f.path + ' (' + f.totalLines + ' Zeilen' + (f.truncated ? ', Ausschnitt' : '') + ') ===\n' + f.content;
  }).join('\n\n');

  var isDep = (finding.category || '').toLowerCase() === 'dependency';

  var auditBlock = finding._npmAudit
    ? '\n## Aktuelles npm audit (Live, Source of Truth)\n' + finding._npmAudit + '\n'
    : '';

  return (isDep
    ? 'Du bist ein Node.js DevOps Engineer. Aktualisiere die betroffene Dependency.\n\n'
    : 'Du bist ein Node.js Security Engineer. Generiere den minimalen Fix.\n\n') +
    '## Analyse\n' + (analyseResult || 'Nicht verfuegbar') + '\n\n' +
    '## Kontext\n' + (kontextResult || 'Nicht verfuegbar') + '\n\n' +
    '## Finding\n' +
    'ID: ' + (finding.id || '-') + ' | Severity: ' + (finding.severity || '-') + '\n' +
    'Titel: ' + (finding.title || '-') + '\n' +
    (finding.description || '') + '\n' +
    (finding.fix ? 'Vorgeschlagener Fix: ' + finding.fix + '\n' : '') +
    auditBlock +
    '\n## Betroffene Dateien\n' + filesStr +
    '\n\n## Antwort-Format\n' +
    'Antworte NUR mit validem JSON:\n' +
    '{"changes":[{"file":"pfad/datei.js","old":"exakter Original-Code","new":"neuer Code"}],' +
    '"explanation":"Was und warum"}\n' +
    'REGELN:\n' +
    '- "old" muss EXAKT im Original vorkommen (1:1 copy aus "## Betroffene Dateien").\n' +
    '- "file" MUSS ein relativer Pfad aus "## Betroffene Dateien" sein. NIEMALS absolute Pfade (/home/…).\n' +
    '- Der Datei-Inhalt in "## Betroffene Dateien" + "## Aktuelles npm audit" ist die Source of Truth.\n' +
    '  Die Finding-Description kann veraltete Empfehlungen enthalten (z.B. Dep-Versionen von vor Tagen).\n' +
    '- NIEMALS Downgrades. Wenn die installierte Version hoeher ist als eine Empfehlung in der\n' +
    '  Description, ist die Empfehlung veraltet. In dem Fall: aktuelle Version behalten oder auf\n' +
    '  die naechste sichere Version per "fixAvailable" aus dem npm audit anheben.\n' +
    '- Bei Dependency-Findings: Pruefe die "via" und "fixAvailable" Felder im npm audit, nicht die\n' +
    '  Description, um die richtige Ziel-Version zu bestimmen.\n' +
    '- Minimale Aenderung. Keine .env/Credentials.';
}

// ── Patch generieren (3-Stufen-Pipeline) ────────────────────────────

// Fuer Dependency-Findings: aktuelles npm audit als strukturierter Kontext. Enricher-
// Descriptions sind oft Tage alt ("axios 0.21.1 → 1.2.1", aktuell bereits 1.7.0) — ohne
// aktuelle Audit-Daten folgt das LLM der veralteten Empfehlung und schlaegt Downgrades
// vor, die dann vom Review abgelehnt werden.
function _npmAuditSnapshot(repoDir) {
  try {
    var raw = child.execSync(
      'cd ' + JSON.stringify(repoDir) + ' && npm audit --json 2>/dev/null || true',
      { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }
    );
    if (!raw || !raw.trim()) return '';
    var parsed = JSON.parse(raw);
    var vulns = parsed.vulnerabilities || {};
    var keys = Object.keys(vulns).slice(0, 25);
    if (!keys.length) return '';
    var summary = { metadata: parsed.metadata || {}, vulnerabilities: {} };
    keys.forEach(function(name) {
      var v = vulns[name];
      summary.vulnerabilities[name] = {
        severity: v.severity,
        range: v.range,
        via: (v.via || []).slice(0, 3).map(function(x) { return typeof x === 'string' ? x : (x.title || x.name); }),
        fixAvailable: v.fixAvailable
      };
    });
    return JSON.stringify(summary, null, 2);
  } catch(e) { return ''; }
}

function generatePatch(finding, repoDir, callback) {
  var files = loadContext(repoDir, finding);
  if (!files.length) {
    return callback(null, { error: 'Keine relevanten Dateien gefunden', files: [] });
  }

  if ((finding.category || '').toLowerCase() === 'dependency') {
    var auditJson = _npmAuditSnapshot(repoDir);
    if (auditJson) finding = Object.assign({}, finding, { _npmAudit: auditJson });
  }

  var severity = (finding.severity || '').toUpperCase();
  var isCritical = severity === 'CRITICAL' || severity === 'HIGH';
  var pipeStart = Date.now();

  // Stufe 1 (Groq: Analyse) + Stufe 2 (Gemini: Kontext) — PARALLEL
  llm.parallel([
    { provider: 'groq', prompt: buildPatchAnalysePrompt(finding), maxTokens: 400, temperature: 0.1, label: 'analyse' },
    { provider: 'gemini', prompt: buildPatchKontextPrompt(finding, files), maxTokens: 512, temperature: 0.1, webSearch: false, label: 'kontext' }
  ], function(results) {
    var s12Time = Date.now() - pipeStart;
    console.log('[CRA/Patcher] Pipeline Stufe 1+2 fertig (' + s12Time + 'ms) — Analyse:', results.analyse ? 'OK' : 'FAIL', '— Kontext:', results.kontext ? 'OK' : 'FAIL');

    // Stufe 3: Patch generieren (Groq, mit Kontext aus 1+2)
    var patchPrompt = buildPatchGenPrompt(finding, files, results.analyse, results.kontext);

    // Alle Severities: Pipeline zuerst (Groq/Gemini), Anthropic nur als Fallback
    // (Kostenoptimierung: Anthropic nicht mehr parallel bei CRITICAL/HIGH)
    llm.ask(patchPrompt, { maxTokens: 2048, temperature: 0.1, webSearch: false }, function(text) {
      var result = parsePatchResponse(text);
      var totalTime = Date.now() - pipeStart;

      if (result && result.changes && result.changes.length > 0) {
        result._pipeline = { mode: '3-stage', s12Time: s12Time, totalTime: totalTime };
        console.log('[CRA/Patcher] Pipeline OK (' + totalTime + 'ms):', result.changes.length, 'Aenderungen');
        return callback(null, result);
      }

      // Fallback: Anthropic
      if (ANTHROPIC_KEY) {
        console.log('[CRA/Patcher] Pipeline Stufe 3 fehlgeschlagen → Anthropic Fallback');
        return anthropicPatch(buildPatchPrompt(finding, files), function(result2) {
          if (result2) result2._pipeline = { mode: 'anthropic-fallback', s12Time: s12Time, totalTime: Date.now() - pipeStart };
          callback(null, result2);
        });
      }

      callback(null, { error: 'Pipeline: kein Patch generiert', changes: [], _pipeline: { mode: 'failed', totalTime: totalTime } });
    });
  });
}


// ── LLM Usage Tracking (lightweight) ───────────────────────────────
function _logLlmUsage(provider, model, usage, context) {
  if (!usage) return;
  try {
    var craDb = require('./cra-db');
    var input = usage.input_tokens || 0;
    var output = usage.output_tokens || 0;
    var cacheW = usage.cache_creation_input_tokens || 0;
    var cacheR = usage.cache_read_input_tokens || 0;

    // Haiku 4.5 pricing (USD per 1M tokens): input $1, output $5, cache_w $1.25, cache_r $0.10
    // Sonnet 4.6 pricing: input $3, output $15, cache_w $3.75, cache_r $0.30
    var isHaiku = (model || '').indexOf('haiku') >= 0;
    var costPerMInput = isHaiku ? 1 : 3;
    var costPerMOutput = isHaiku ? 5 : 15;
    var costPerMCacheW = costPerMInput * 1.25;
    var costPerMCacheR = costPerMInput * 0.10;

    var cost = (input * costPerMInput + output * costPerMOutput + cacheW * costPerMCacheW + cacheR * costPerMCacheR) / 1000000;

    craDb.run(
      "INSERT INTO cra_llm_usage (provider, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, context) VALUES (?,?,?,?,?,?,?,?)",
      [provider, model, input, output, cacheW, cacheR, cost, context || null]
    );
    craDb.saveCraDb();
  } catch(e) { /* tracking darf nie Haupt-Flow brechen */ }
}

// ── Anthropic API für Patch ─────────────────────────────────────────

function anthropicPatch(prompt, callback) {
  // Split prompt an statischer/dynamischer Grenze fuer Prompt Caching
  var SYSTEM_MARKER = '\n## Finding\n';
  var idx = prompt.indexOf(SYSTEM_MARKER);
  var systemPart = idx > 0 ? prompt.substring(0, idx) : '';
  var userPart = idx > 0 ? prompt.substring(idx + 1) : prompt;

  var userBlocks = [];
  if (systemPart) {
    userBlocks.push({ type: 'text', text: systemPart, cache_control: { type: 'ephemeral' } });
  }
  userBlocks.push({ type: 'text', text: userPart });

  var body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: userBlocks }]
  });

  var req = https.request({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    }
  }, function(res) {
    var data = '';
    res.on('data', function(c) { data += c; });
    res.on('end', function() {
      try {
        var resp = JSON.parse(data);
        if (resp.error) {
          console.error('[CRA/Patcher] Anthropic-Fehler:', resp.error.message);
          return callback({ error: resp.error.message, changes: [] });
        }
        _logLlmUsage('anthropic', resp.model || 'claude-haiku-4-5-20251001', resp.usage, 'patcher');
        var text = resp.content && resp.content[0] ? resp.content[0].text : '';
        var result = parsePatchResponse(text);
        callback(result || { error: 'Antwort nicht parsebar', changes: [] });
      } catch(e) {
        callback({ error: 'Parse-Fehler: ' + e.message, changes: [] });
      }
    });
  });
  req.on('error', function(e) { callback({ error: 'HTTP-Fehler: ' + e.message, changes: [] }); });
  req.setTimeout(60000, function() { req.destroy(); callback({ error: 'Timeout (60s)', changes: [] }); });
  req.write(body);
  req.end();
}

// ── LLM-Antwort parsen ──────────────────────────────────────────────

function parsePatchResponse(text) {
  if (!text) return null;
  // JSON aus Antwort extrahieren
  var jsonMatch = text.match(/\{[\s\S]*"changes"[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    var parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.changes || !Array.isArray(parsed.changes)) return null;

    // Validieren: jede Change braucht file, old, new
    var valid = parsed.changes.filter(function(c) {
      return c.file && typeof c.old === 'string' && typeof c.new === 'string'
        && c.old !== c.new && c.old.length > 0;
    });

    // Blacklist prüfen
    valid = valid.filter(function(c) {
      var basename = path.basename(c.file);
      if (BLACKLIST.indexOf(basename) >= 0) return false;
      if (BLACKLIST_EXT.some(function(ext) { return basename.endsWith(ext); })) return false;
      if (c.file.indexOf('..') >= 0) return false; // Path Traversal
      return true;
    });

    if (!valid.length) return null;
    return { changes: valid, explanation: parsed.explanation || '' };
  } catch(e) {
    return null;
  }
}

// ── Patch anwenden (Dateien editieren) ──────────────────────────────

function findFileInRepo(repoDir, basename) {
  try {
    var r = child.execSync(
      'find ' + JSON.stringify(repoDir) + ' -type f -name ' + JSON.stringify(basename)
      + ' -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -10',
      { encoding: 'utf8', timeout: 5000 }
    );
    if (!r || !r.trim()) return [];
    return r.trim().split('\n').map(function(f) { return path.relative(repoDir, f); });
  } catch(e) { return []; }
}

function applyPatch(repoDir, patch) {
  var applied = [];
  var failed = [];

  patch.changes.forEach(function(change) {
    // LLM liefert manchmal absolute Prod-Pfade aus Enricher-Descriptions;
    // auf Basename reduzieren und im Repo rekursiv suchen (eindeutige Treffer akzeptieren).
    var relFile = change.file;
    if (path.isAbsolute(relFile)) {
      var hits = findFileInRepo(repoDir, path.basename(relFile));
      if (hits.length === 1) {
        relFile = hits[0];
      } else if (hits.length > 1) {
        failed.push({ file: change.file, error: 'Absoluter Pfad mehrdeutig im Repo: ' + hits.join(', ') });
        return;
      } else {
        failed.push({ file: change.file, error: 'Datei (basename ' + path.basename(relFile) + ') nicht im Repo gefunden' });
        return;
      }
    }

    var fullPath = path.resolve(repoDir, relFile);
    // Sandbox: muss innerhalb repoDir bleiben
    if (!fullPath.startsWith(path.resolve(repoDir))) {
      failed.push({ file: change.file, error: 'Path Traversal' });
      return;
    }
    if (!fs.existsSync(fullPath)) {
      failed.push({ file: change.file, error: 'Datei nicht gefunden' });
      return;
    }

    try {
      var content = fs.readFileSync(fullPath, 'utf8');
      var newContent;
      if (content.indexOf(change.old) >= 0) {
        newContent = content.replace(change.old, change.new);
      } else {
        // Fuzzy-Fallback: LLM trifft Whitespace/Quote-Varianten nicht immer exakt.
        // Normalisieren (Whitespace → ein Space) und einen Regex konstruieren der
        // den Original-Whitespace wieder zulaesst. Nur anwenden wenn im normalisierten
        // Content GENAU eine Fundstelle ist — mehrdeutig → fail.
        var normOld = change.old.trim().replace(/\s+/g, ' ');
        var normContent = content.replace(/\s+/g, ' ');
        var normIdx = normContent.indexOf(normOld);
        if (normIdx < 0 || normContent.indexOf(normOld, normIdx + 1) >= 0) {
          failed.push({ file: change.file, error: 'old-String nicht gefunden' });
          return;
        }
        // Regex: Whitespace-Gruppen aus normOld werden im Original als \s+ interpretiert.
        var pattern = normOld.split(' ').map(function(p) {
          return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('\\s+');
        var m = content.match(new RegExp(pattern));
        if (!m) {
          failed.push({ file: change.file, error: 'old-String nicht gefunden (auch fuzzy)' });
          return;
        }
        newContent = content.replace(m[0], change.new);
      }
      fs.writeFileSync(fullPath, newContent, 'utf8');
      applied.push(change.file);
    } catch(e) {
      failed.push({ file: change.file, error: e.message });
    }
  });

  return { applied: applied, failed: failed };
}

// ── Syntax-Check ────────────────────────────────────────────────────

function syntaxCheck(repoDir, files) {
  var errors = [];
  files.forEach(function(f) {
    var fullPath = path.join(repoDir, f);
    if (!fs.existsSync(fullPath)) return;

    if (f.endsWith('.js')) {
      try {
        child.execSync('node --check ' + JSON.stringify(fullPath), { encoding: 'utf8', timeout: 5000 });
      } catch(e) {
        errors.push({ file: f, error: (e.stderr || e.message || '').substring(0, 200) });
      }
    } else if (f.endsWith('.json')) {
      try {
        JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      } catch(e) {
        errors.push({ file: f, error: 'Invalid JSON: ' + e.message });
      }
    }
  });
  return errors;
}

// ── Cross-Model-Review (anderes LLM als der Patcher) ────────────────

function crossReview(finding, patch, callback) {
  var prompt = 'Du bist ein Security Code Reviewer. Pruefe ob dieser Patch das Finding korrekt loest.\n\n'
    + 'Finding: ' + finding.title + ' (' + finding.severity + ')\n'
    + finding.description + '\n\n'
    + 'Patch:\n' + patch.changes.map(function(c) {
      return '--- ' + c.file + '\n- ' + c.old.substring(0, 500) + '\n+ ' + c.new.substring(0, 500);
    }).join('\n\n')
    + '\n\nAntworte NUR mit JSON: {"verdict":"approve"|"reject","reason":"..."}';

  // Wenn Patcher Groq nutzte → Review mit Gemini, und umgekehrt
  llm.askGemini(prompt, { maxTokens: 512, temperature: 0.1, webSearch: false }, function(text) {
    if (text) {
      var match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          var result = JSON.parse(match[0]);
          return callback(null, result);
        } catch(e) { /* parse error */ }
      }
    }
    // Fallback: Groq
    llm.askGroq(prompt, { maxTokens: 512, temperature: 0.1 }, function(text2) {
      if (text2) {
        var match2 = text2.match(/\{[\s\S]*\}/);
        if (match2) {
          try { return callback(null, JSON.parse(match2[0])); } catch(e) { /* */ }
        }
      }
      // Kein Review möglich → konservativ ablehnen
      callback(null, { verdict: 'reject', reason: 'Review nicht moeglich (kein LLM erreichbar)' });
    });
  });
}

module.exports = {
  generatePatch: generatePatch,
  applyPatch: applyPatch,
  syntaxCheck: syntaxCheck,
  crossReview: crossReview,
  loadContext: loadContext,
  BLACKLIST: BLACKLIST
};
