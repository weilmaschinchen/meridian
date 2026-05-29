// admin/cra/cra-review-engine.js — Code-Review Engine (CommonJS)
// Statische Checks + LLM-Review (LiteLLM → Groq/Gemini → Anthropic)
var https = require('https');
var http = require('http');
var craDb = require('./cra-db');
var llm = require('../lib/llm'); // LLM-Abstraktion (CRA Plus bindet via MERIDIAN_LLM_ADAPTER opsdesk an)
var kisCtx = require('./kis-context');

var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
var AI_MODEL = 'claude-haiku-4-5-20251001';
var LITELLM_HOST = process.env.LITELLM_URL ? require('url').parse(process.env.LITELLM_URL).hostname : 'localhost';
var LITELLM_PORT = process.env.LITELLM_URL ? (parseInt(require('url').parse(process.env.LITELLM_URL).port || '4000', 10)) : 4000;
var LITELLM_MODEL = 'cra-plus-llm';

// ── Statische Review-Kriterien ──────────────────────────────────

var REVIEW_CRITERIA = [
  {
    id: 'scope',
    name: 'Scope-Check',
    check: function(diff, finding) {
      if (!finding || !finding.allowed_files || !finding.allowed_files.length) return null; // Skip wenn keine Einschraenkung
      var outOfScope = diff.files.filter(function(f) {
        return finding.allowed_files.indexOf(f) < 0;
      });
      if (outOfScope.length > 0) return 'Dateien ausserhalb Finding-Scope: ' + outOfScope.join(', ');
      return null;
    }
  },
  {
    id: 'no_sql_concat',
    name: 'SQL-Injection Prevention',
    check: function(diff) {
      var pattern = /['"`]\s*\+\s*(?:req\.|params\.|body\.|query\.)/;
      if (pattern.test(diff.addedText)) return 'SQL-String-Konkatenation mit externen Werten entdeckt';
      return null;
    }
  },
  {
    id: 'no_secrets',
    name: 'Keine Secrets im Code',
    check: function(diff) {
      var pattern = /(?:password|secret|api_key|access_token)\s*=\s*['"][^$][^'"]{8,}['"]/i;
      if (pattern.test(diff.addedText)) return 'Moeglicher Hardcoded Secret entdeckt';
      return null;
    }
  },
  {
    id: 'no_pii_logs',
    name: 'Kein PII in Logs',
    check: function(diff) {
      var pattern = /console\.(log|error|warn)\s*\(.*(?:email|name|phone|address|geburtsdatum|iban)/i;
      if (pattern.test(diff.addedText)) return 'PII in Log-Ausgabe entdeckt';
      return null;
    }
  },
  {
    id: 'yagni',
    name: 'YAGNI — kein Scope-Creep',
    check: function(diff, finding) {
      if (!finding || !finding.max_lines_changed) return null;
      var limit = Math.ceil(finding.max_lines_changed * 1.2);
      if (diff.additions > limit) return 'Aenderung (' + diff.additions + ' Zeilen) deutlich groesser als Finding-Scope (' + finding.max_lines_changed + ' erwartet)';
      return null;
    }
  },
  {
    id: 'srp',
    name: 'Single Responsibility',
    check: function(diff) {
      // Heuristik: Wenn mehr als 5 verschiedene Verzeichnisse geaendert werden
      var dirs = {};
      diff.files.forEach(function(f) {
        var parts = f.split('/');
        if (parts.length > 1) dirs[parts.slice(0, -1).join('/')] = 1;
      });
      if (Object.keys(dirs).length > 5) return 'Aenderung beruehrt ' + Object.keys(dirs).length + ' Verzeichnisse — SRP-Verletzung moeglich';
      return null;
    }
  },
  {
    id: 'dry',
    name: 'DRY — keine Duplikation',
    check: function(diff) {
      // Heuristik: Suche nach duplizierten laengeren Bloecken (>3 Zeilen identisch)
      var addedLines = diff.addedText.split('\n').filter(function(l) { return l.trim().length > 20; });
      var seen = {};
      var dupes = 0;
      addedLines.forEach(function(l) {
        var trimmed = l.trim();
        if (seen[trimmed]) dupes++;
        seen[trimmed] = true;
      });
      if (dupes > 5) return dupes + ' duplizierte Code-Zeilen entdeckt — DRY-Verletzung moeglich';
      return null;
    }
  }
];

// ── Diff-Parser ─────────────────────────────────────────────────

function parseDiff(rawDiff) {
  var lines = (rawDiff || '').split('\n');
  var files = [];
  var addedLines = [];
  var deletedLines = [];
  var additions = 0;
  var deletions = 0;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    // Dateinamen aus +++ Zeilen extrahieren
    if (line.startsWith('+++ b/')) {
      var fname = line.substring(6);
      if (files.indexOf(fname) < 0) files.push(fname);
    } else if (line.startsWith('+++ ')) {
      var fname2 = line.substring(4).replace(/^a\/|^b\//, '');
      if (fname2 !== '/dev/null' && files.indexOf(fname2) < 0) files.push(fname2);
    }
    // Additions/Deletions zaehlen
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
      addedLines.push(line.substring(1));
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
      deletedLines.push(line.substring(1));
    }
  }

  return {
    files: files,
    additions: additions,
    deletions: deletions,
    addedText: addedLines.join('\n'),
    deletedText: deletedLines.join('\n'),
    raw: rawDiff
  };
}

// ── Prompt-Builder fuer 3-Stufen-Pipeline ───────────────────────

function buildFindingContext(finding) {
  if (!finding) return 'Kein Finding-Kontext';
  return JSON.stringify({
    id: finding.id, title: finding.title, severity: finding.severity,
    category: finding.category, description: finding.description,
    acceptance_criteria: finding.acceptance_criteria
  });
}

function truncateDiff(diff, maxLen) {
  var d = diff.raw || '';
  if (d.length > maxLen) d = d.substring(0, maxLen) + '\n... (gekuerzt)';
  return d;
}

// Stufe 1: INHALT — Was wurde geaendert? (Groq, schnell)
function buildStage1Prompt(diff, finding) {
  return 'Analysiere diesen Code-Diff. Extrahiere NUR strukturierte Fakten.\n' +
    'Antworte NUR mit validem JSON:\n' +
    '{"changed_files":[{"file":"...","type":"new|modified|deleted","changes":"kurze Beschreibung"}],' +
    '"new_endpoints":[{"method":"GET|POST|...","path":"...","auth":"yes|no"}],' +
    '"db_changes":["..."],' +
    '"security_patterns":["SQL concat","hardcoded secret","PII in log","eval/exec","no auth"],' +
    '"dependency_changes":["..."],' +
    '"complexity":"low|medium|high"}\n\n' +
    'Finding:\n' + buildFindingContext(finding) + '\n\n' +
    'Diff:\n' + truncateDiff(diff, 6000);
}

// Stufe 2: KONTEXT — Welche Auswirkungen? (Gemini, parallel)
function buildStage2Prompt(diff, finding) {
  return 'Analysiere den Kontext dieses Code-Diffs. Fokus: Auswirkungen und Blast-Radius.\n' +
    'Antworte NUR mit validem JSON:\n' +
    '{"affected_areas":[{"area":"...","impact":"direct|indirect","risk":"low|medium|high"}],' +
    '"breaking_changes":["..."],' +
    '"missing_changes":["Stellen die auch geaendert werden muessten aber fehlen"],' +
    '"test_coverage":"adequate|insufficient|none",' +
    '"blast_radius":"low|medium|high",' +
    '"data_risk":"none|read|write|delete"}\n\n' +
    'Finding:\n' + buildFindingContext(finding) + '\n\n' +
    'Diff:\n' + truncateDiff(diff, 6000);
}

// Stufe 3: URTEIL — Finale Entscheidung (Groq, basierend auf Stufe 1+2)
function buildStage3Prompt(stage1Result, stage2Result, staticFailures) {
  return 'Du bist der finale Reviewer. Basierend auf Inhalt-Analyse und Kontext-Analyse: Approve oder Block?\n\n' +
    'Antworte NUR mit validem JSON:\n' +
    '{"decision":"approve"|"request_changes",' +
    '"comments":["konkreter Kommentar pro Problem"],' +
    '"law_violations":["Nur falls Datenschutz/DSGVO/Compliance verletzt"],' +
    '"risk_score":0,' +
    '"summary":"Ein-Satz-Zusammenfassung"}\n\n' +
    'risk_score: 0-10 (0=kein Risiko, 10=kritisch)\n\n' +
    'Statische Checks: ' + (staticFailures.length > 0 ? JSON.stringify(staticFailures) : 'Alle bestanden') + '\n\n' +
    'Inhalt-Analyse (Stufe 1):\n' + (stage1Result || 'Nicht verfuegbar — konservativ bewerten') + '\n\n' +
    'Kontext-Analyse (Stufe 2):\n' + (stage2Result || 'Nicht verfuegbar — konservativ bewerten');
}

// Legacy-Prompt fuer Anthropic-Fallback (Single-Call)
function buildReviewPrompt(diff, finding, kisBlock) {
  // STATISCHER TEIL (Ziel: >= 1024 Tokens fuer Anthropic Prompt Caching)
  // Der Split in anthropicReview erfolgt am Marker '\n## Finding\n'.
  var staticContext =
      'Du bist ein Senior Security Code Reviewer fuer das kurven.schule Node.js Oekosystem.\n'
    + 'Deine Aufgabe: einen Diff gegen ein bekanntes Finding bewerten.\n'
    + '\n## Stack-Kontext\n'
    + '- Node.js 22.x, Express, SQLite (better-sqlite3 oder sql.js Legacy)\n'
    + '- 6 Apps im Oekosystem, SSO via KS_SSO_SECRET\n'
    + '- Apps laufen unter eigenen Linux-Usern mit PM2\n'
    + '\n## Bewertung — nur zwei Moeglichkeiten\n'
    + '- "approve": Diff loest das Finding korrekt und vollstaendig\n'
    + '- "request_changes": Diff ist unvollstaendig, falsch, riskant oder verschlechtert den Code\n'
    + '\n## Approve-Kriterien (alle muessen erfuellt sein)\n'
    + '- Kernursache gemaess Finding-Beschreibung beseitigt\n'
    + '- Keine unbeabsichtigten Nebenwirkungen im Diff\n'
    + '- SOLID: Single-Responsibility, keine neuen Gott-Funktionen\n'
    + '- DRY: keine offensichtliche Duplikation\n'
    + '- KISS: einfachste plausible Loesung\n'
    + '- YAGNI: keine spekulativen Vorab-Features\n'
    + '- Kein neuer hardcoded Secret, kein Keyleak, kein offener SQL-Concat mehr\n'
    + '- Keine Dependencies hinzugefuegt die nicht direkt fix-noetig sind\n'
    + '\n## Typische Request-Changes-Gruende\n'
    + '1. Fix oberflaechlich: Symptom behoben, Ursache bleibt\n'
    + '2. Neue Vulnerability eingefuehrt (z.B. "Fix" fuer XSS per innerHTML erzeugt DOM-XSS)\n'
    + '3. Validierung an falscher Stelle (sollte am Request-Boundary, nicht tief intern)\n'
    + '4. Regex-Bypass moeglich (Pattern nicht anker-fest, fehlende Flags)\n'
    + '5. Refactoring zusaetzlich zum Fix (unnoetiger Blast-Radius, schwer reviewbar)\n'
    + '6. Prepared-Statement falsch benutzt (z.B. Tabellenname als Parameter)\n'
    + '7. Path-Traversal-Check fehlt nach path.resolve\n'
    + '8. Secrets in Logs oder Error-Messages geleaked\n'
    + '9. Dependency geupdated, aber Breaking-Change nicht im Code nachgezogen\n'
    + '10. Fix nur in einer Datei obwohl dasselbe Pattern mehrfach im Repo vorkommt\n'
    + '\n## Beispiel 1 — Approve\n'
    + 'Finding: "SQL-Injection via String-Konkat"\n'
    + 'Diff: db.prepare() mit "?" Placeholder statt +, User-ID als get-Parameter\n'
    + '-> "approve", comments: ["Prepared Statement korrekt, Semantik unveraendert"]\n'
    + '\n## Beispiel 2 — Request Changes\n'
    + 'Finding: "XSS durch innerHTML"\n'
    + 'Diff: innerHTML auf einer Stelle durch textContent ersetzt, aber bei Zeile 42 neue Funktion mit innerHTML hinzugefuegt\n'
    + '-> "request_changes", comments: ["Neues innerHTML in Funktion renderComment eingefuegt — gleiche Vulnerability wiederhergestellt"]\n'
    + '\n## Beispiel 3 — Request Changes (subtiler)\n'
    + 'Finding: "Hardcoded API-Key im Repo"\n'
    + 'Diff: Key durch process.env.API_KEY ersetzt, aber Default-Wert ist der alte Key\n'
    + '-> "request_changes", comments: ["Default-Wert ist der geleakte Key — Secret bleibt im Code"]\n'
    + '\n## Beispiel 4 — Approve (Dependency mit aelterer Empfehlung)\n'
    + 'Finding-Description sagt: "axios 0.21.1 → 1.2.1" (Enricher vom 13.04.)\n'
    + 'Diff: package.json axios "^1.7.0" → "^1.7.7"\n'
    + '-> "approve", comments: ["Installierte Version bereits >1.2.1; 1.7.7 ist die aktuelle Patch-Version der 1.7.x-Serie, enthaelt den SSRF-Fix, kein Downgrade"]\n'
    + 'MERKE: Die Empfehlung in der Description kann ueberholt sein. Wenn die neue Version >=\n'
    + 'der empfohlenen Version ist und in derselben Major-Serie bleibt, ist es ein valider Fix.\n'
    + 'Ein Update VON niedriger AUF hoeher ist NIE ein Downgrade, auch wenn die Description eine\n'
    + 'aeltere Zielversion nennt. Reject nur wenn tatsaechlich downgraded wird (1.7.0 → 1.2.1 etc).\n'
    + '\n## Antwort-Format (STRICT JSON)\n'
    + 'Antworte NUR mit validem JSON. Kein Markdown-Codeblock, kein Text davor/danach.\n'
    + '```\n'
    + '{\n'
    + '  "decision": "approve" | "request_changes",\n'
    + '  "comments": ["kurzer Grund 1", "kurzer Grund 2"],\n'
    + '  "law_violations": ["DRY", "KISS"],\n'
    + '  "risk_score": 0,\n'
    + '  "summary": "ein Satz Gesamtbewertung"\n'
    + '}\n'
    + '```\n'
    + '- decision ist Pflicht\n'
    + '- comments: 1-4 Eintraege, konkret und technisch\n'
    + '- law_violations: leer bei approve, enthaelt SOLID/DRY/KISS/YAGNI bei Verstoss\n'
    + '- risk_score: 0 bei approve, 1-100 bei request_changes (je hoeher, je kritischer)\n';

  return staticContext
    + (kisBlock || '')
    + '\n## Finding\n'
    + buildFindingContext(finding)
    + '\n\n## Diff\n' + truncateDiff(diff, 8000);
}

function parseReviewResponse(text) {
  if (!text) return null;
  var jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    var parsed = JSON.parse(jsonMatch[0]);
    if (parsed.decision && (parsed.decision === 'approve' || parsed.decision === 'request_changes')) {
      return {
        decision: parsed.decision,
        comments: parsed.comments || [],
        law_violations: parsed.law_violations || [],
        risk_score: parsed.risk_score || 0,
        summary: parsed.summary || ''
      };
    }
  } catch(e) { /* ignore */ }
  return null;
}

function parseStageResponse(text) {
  if (!text) return null;
  var jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try { return JSON.parse(jsonMatch[0]); } catch(e) { return null; }
}

// ── 3-Stufen-Pipeline (Groq + Gemini parallel, dann Groq Urteil) ──

function pipelineReview(diff, finding, staticFailures, callback) {
  var pipelineStart = Date.now();

  // Stufe 1 (Groq: Inhalt) + Stufe 2 (Gemini: Kontext) — PARALLEL
  llm.parallel([
    { provider: 'groq', prompt: buildStage1Prompt(diff, finding), maxTokens: 512, temperature: 0.1, label: 'inhalt' },
    { provider: 'gemini', prompt: buildStage2Prompt(diff, finding), maxTokens: 512, temperature: 0.1, webSearch: false, label: 'kontext' }
  ], function(results) {
    var s1Time = Date.now() - pipelineStart;
    var stage1 = results.inhalt;
    var stage2 = results.kontext;

    console.log('[CRA/Review] Pipeline Stufe 1+2 fertig (' + s1Time + 'ms) — Inhalt:', stage1 ? 'OK' : 'FAIL', '— Kontext:', stage2 ? 'OK' : 'FAIL');

    // Falls beide Stufen fehlschlagen → Anthropic Fallback
    if (!stage1 && !stage2) {
      console.log('[CRA/Review] Pipeline Stufe 1+2 beide leer → Anthropic Fallback');
      if (ANTHROPIC_KEY) {
        return anthropicReview(buildReviewPrompt(diff, finding), function(err, result) {
          if (result) result._pipeline = { mode: 'anthropic-fallback', s1Time: s1Time, totalTime: Date.now() - pipelineStart };
          callback(err, result);
        });
      }
      return callback(null, { decision: 'skip', comments: ['Pipeline fehlgeschlagen — kein LLM erreichbar'], law_violations: [], _pipeline: { mode: 'failed' } });
    }

    // Stufe 3: URTEIL (Groq) — basierend auf Stufe 1+2 Ergebnissen
    var stage3Prompt = buildStage3Prompt(stage1, stage2, staticFailures);
    llm.askGroq(stage3Prompt, { maxTokens: 400, temperature: 0.1 }, function(text) {
      var totalTime = Date.now() - pipelineStart;
      var result = parseReviewResponse(text);

      if (result) {
        // Pipeline-Metadaten anhaengen
        var s1Parsed = parseStageResponse(stage1);
        var s2Parsed = parseStageResponse(stage2);
        result._pipeline = {
          mode: '3-stage',
          s1Time: s1Time,
          totalTime: totalTime,
          inhalt: s1Parsed,
          kontext: s2Parsed
        };
        console.log('[CRA/Review] Pipeline Stufe 3 OK:', result.decision, '— Score:', result.risk_score, '—', totalTime + 'ms');
        return callback(null, result);
      }

      // Stufe 3 via Gemini Fallback
      console.log('[CRA/Review] Stufe 3 Groq fehlgeschlagen → Gemini Fallback');
      llm.askGemini(stage3Prompt, { maxTokens: 400, temperature: 0.1, webSearch: false }, function(text2) {
        var totalTime2 = Date.now() - pipelineStart;
        var result2 = parseReviewResponse(text2);
        if (result2) {
          result2._pipeline = { mode: '3-stage-gemini-s3', s1Time: s1Time, totalTime: totalTime2 };
          console.log('[CRA/Review] Pipeline Stufe 3 (Gemini) OK:', result2.decision, '—', totalTime2 + 'ms');
          return callback(null, result2);
        }

        // Alles fehlgeschlagen → Anthropic
        if (ANTHROPIC_KEY) {
          console.log('[CRA/Review] Pipeline komplett fehlgeschlagen → Anthropic Fallback');
          return anthropicReview(buildReviewPrompt(diff, finding), function(err, result3) {
            if (result3) result3._pipeline = { mode: 'anthropic-fallback', s1Time: s1Time, totalTime: Date.now() - pipelineStart };
            callback(err, result3);
          });
        }

        callback(null, { decision: 'skip', comments: ['Pipeline: Stufe 3 nicht parsebar'], law_violations: [], _pipeline: { mode: 'failed', totalTime: totalTime2 } });
      });
    });
  });
}

// ── LLM Review (LiteLLM primary → 3-Stufen-Pipeline → Anthropic) ──

function aiReview(diff, finding, staticFailures, callback) {
  var severity = finding ? (finding.severity || '').toUpperCase() : '';
  var isCritical = severity === 'CRITICAL' || severity === 'HIGH';

  // LiteLLM zuerst versuchen (DeepSeek V4 → Haiku via Router)
  litellmReview(diff, finding, function(err, litellmResult) {
    if (litellmResult) {
      // Bei CRITICAL/HIGH zusätzlich Anthropic Cross-Check
      if (isCritical && ANTHROPIC_KEY) {
        var prompt = buildReviewPrompt(diff, finding);
        anthropicReview(prompt, function(aerr, anthropicResult) {
          if (anthropicResult && anthropicResult.decision === 'request_changes') {
            anthropicResult._pipeline = litellmResult._pipeline;
            anthropicResult._crossCheck = 'anthropic-wins-litellm';
            if (litellmResult.comments) {
              anthropicResult.comments = (anthropicResult.comments || []).concat(
                litellmResult.comments.filter(function(c) { return (anthropicResult.comments || []).indexOf(c) < 0; })
              );
            }
            return callback(null, anthropicResult);
          }
          if (litellmResult.decision === 'request_changes') {
            litellmResult._crossCheck = 'litellm-wins';
            return callback(null, litellmResult);
          }
          var merged = litellmResult;
          if (anthropicResult) {
            merged.comments = (litellmResult.comments || []).concat(
              (anthropicResult.comments || []).filter(function(c) { return (litellmResult.comments || []).indexOf(c) < 0; })
            );
            merged._crossCheck = 'both-approve';
          }
          callback(null, merged);
        });
        return;
      }
      return callback(null, litellmResult);
    }

    // LiteLLM nicht erreichbar → Legacy-Pipeline
    console.log('[CRA/Review] LiteLLM fehlgeschlagen → 3-Stufen-Pipeline Fallback');

  // CRITICAL/HIGH: Pipeline + Anthropic Cross-Check
  if (isCritical && ANTHROPIC_KEY) {
    console.log('[CRA/Review] CRITICAL/HIGH → Pipeline + Anthropic Cross-Check');
    var prompt = buildReviewPrompt(diff, finding);
    // Pipeline und Anthropic parallel starten
    var pipelineResult = null;
    var anthropicResult = null;
    var done = 0;

    function checkBoth() {
      done++;
      if (done < 2) return;
      // Konservativstes Ergebnis gewinnt
      if (anthropicResult && anthropicResult.decision === 'request_changes') {
        anthropicResult._pipeline = pipelineResult ? pipelineResult._pipeline : null;
        anthropicResult._crossCheck = 'anthropic-wins';
        if (pipelineResult && pipelineResult.comments) {
          anthropicResult.comments = (anthropicResult.comments || []).concat(pipelineResult.comments.filter(function(c) {
            return anthropicResult.comments.indexOf(c) < 0;
          }));
        }
        return callback(null, anthropicResult);
      }
      if (pipelineResult && pipelineResult.decision === 'request_changes') {
        pipelineResult._crossCheck = 'pipeline-wins';
        return callback(null, pipelineResult);
      }
      // Beide approve → merge comments
      var merged = pipelineResult || anthropicResult || { decision: 'approve', comments: [], law_violations: [] };
      if (anthropicResult && pipelineResult) {
        merged.comments = (pipelineResult.comments || []).concat((anthropicResult.comments || []).filter(function(c) {
          return (pipelineResult.comments || []).indexOf(c) < 0;
        }));
        merged._crossCheck = 'both-approve';
      }
      callback(null, merged);
    }

    pipelineReview(diff, finding, staticFailures, function(err, r) { pipelineResult = r; checkBoth(); });
    anthropicReview(prompt, function(err, r) { anthropicResult = r; checkBoth(); });
    return;
  }

  // Alles andere → 3-Stufen-Pipeline (kostenlos)
  console.log('[CRA/Review] Standard → 3-Stufen-Pipeline');
  pipelineReview(diff, finding, staticFailures, callback);
  }); // litellmReview fallback end
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

// ── LiteLLM (DeepSeek V4 → Claude Haiku, OpenAI-compatible) ────────

function litellmReview(diff, finding, callback) {
  var queryText = (diff.commitMessage || '') + ' ' + (diff.files || []).slice(0, 5).join(' ');
  kisCtx.fetchKisContext(queryText, function(err, kis) {
    var kisBlock = kis ? kisCtx.buildKisBlock(kis) : '';
    _litellmReviewWithContext(diff, finding, kisBlock, callback);
  });
}

function _litellmReviewWithContext(diff, finding, kisBlock, callback) {
  var prompt = buildReviewPrompt(diff, finding, kisBlock);
  var body = JSON.stringify({
    model: LITELLM_MODEL,
    max_tokens: 1000,
    temperature: 0.1,
    messages: [{ role: 'user', content: prompt }]
  });

  var req = http.request({
    hostname: LITELLM_HOST,
    port: LITELLM_PORT,
    path: '/chat/completions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, function(res) {
    var data = '';
    res.on('data', function(c) { data += c; });
    res.on('end', function() {
      try {
        var resp = JSON.parse(data);
        if (resp.error) {
          console.error('[CRA/Review] LiteLLM-Fehler:', resp.error.message || JSON.stringify(resp.error));
          return callback(null, null);
        }
        var text = resp.choices && resp.choices[0] ? resp.choices[0].message.content : '';
        if (resp.usage) {
          _logLlmUsage('litellm', resp.model || LITELLM_MODEL,
            { input_tokens: resp.usage.prompt_tokens, output_tokens: resp.usage.completion_tokens }, 'review');
        }
        var result = parseReviewResponse(text);
        if (result) {
          result._pipeline = { mode: 'litellm', model: resp.model || LITELLM_MODEL };
          console.log('[CRA/Review] LiteLLM OK:', result.decision, '— Model:', resp.model || LITELLM_MODEL);
          return callback(null, result);
        }
        callback(null, null);
      } catch(e) {
        console.error('[CRA/Review] LiteLLM Parse-Fehler:', e.message);
        callback(null, null);
      }
    });
  });

  req.on('error', function(e) {
    console.warn('[CRA/Review] LiteLLM nicht erreichbar:', e.message);
    callback(null, null);
  });

  req.setTimeout(30000, function() {
    req.destroy();
    console.warn('[CRA/Review] LiteLLM Timeout (30s)');
    callback(null, null);
  });

  req.write(body);
  req.end();
}

// ── Anthropic API (Fallback fuer kritische Findings + LLM-Fehler) ──

function anthropicReview(prompt, callback) {
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
    model: AI_MODEL,
    max_tokens: 1000,
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
          console.error('[CRA/Review] Anthropic-Fehler:', resp.error.message || resp.error);
          return callback(null, { decision: 'skip', comments: ['Anthropic-Fehler: ' + (resp.error.message || 'unbekannt')], law_violations: [] });
        }
        _logLlmUsage('anthropic', resp.model || AI_MODEL, resp.usage, 'review');
        var text = resp.content && resp.content[0] ? resp.content[0].text : '';
        var result = parseReviewResponse(text);
        if (result) {
          callback(null, result);
        } else {
          callback(null, { decision: 'request_changes', comments: ['AI-Antwort nicht parsebar: ' + text.substring(0, 200)], law_violations: [] });
        }
      } catch (e) {
        console.error('[CRA/Review] Parse-Fehler:', e.message);
        callback(null, { decision: 'skip', comments: ['Response-Parse-Fehler: ' + e.message], law_violations: [] });
      }
    });
  });

  req.on('error', function(e) {
    console.error('[CRA/Review] HTTP-Fehler:', e.message);
    callback(null, { decision: 'skip', comments: ['HTTP-Fehler: ' + e.message], law_violations: [] });
  });

  req.setTimeout(30000, function() {
    req.destroy();
    callback(null, { decision: 'skip', comments: ['API-Timeout (30s)'], law_violations: [] });
  });

  req.write(body);
  req.end();
}

// ── Hauptfunktion: evaluate() ───────────────────────────────────

function evaluate(opts, callback) {
  var startTime = Date.now();
  var rawDiff = opts.diff || '';
  var findingId = opts.finding_id || null;
  var finding = opts.finding || null;
  var testResults = opts.test_results || null;

  // Finding aus DB laden falls nur ID uebergeben
  if (!finding && findingId) {
    finding = craDb.get('SELECT * FROM findings WHERE id = ?', [findingId]);
    if (finding && finding.apps_json) {
      try { finding.allowed_files = JSON.parse(finding.apps_json); } catch (e) { /* ignore */ }
    }
  }

  var diff = parseDiff(rawDiff);

  // 1. Statische Checks
  var staticFailures = [];
  REVIEW_CRITERIA.forEach(function(criterion) {
    var result = criterion.check(diff, finding);
    if (result) {
      staticFailures.push({ id: criterion.id, name: criterion.name, message: result });
    }
  });

  // 2. Iterations-Check (max 3 pro Finding)
  var iteration = 1;
  if (findingId) {
    var prevReviews = craDb.get(
      "SELECT COUNT(*) as c FROM review_requests WHERE finding_id = ? AND decision = 'request_changes'",
      [findingId]
    );
    iteration = ((prevReviews && prevReviews.c) || 0) + 1;
    if (iteration > 3) {
      var result = {
        decision: 'escalate',
        comments: ['3 aufeinanderfolgende Review-Ablehnungen — automatische Eskalation (STOP_4)'],
        static_failures: staticFailures,
        ai_review: null,
        law_violations: [],
        iteration: iteration,
        diff: { files: diff.files, additions: diff.additions, deletions: diff.deletions }
      };
      saveReview(result, findingId, diff, startTime);
      return callback(null, result);
    }
  }

  // 3. KI-Review (3-Stufen-Pipeline)
  aiReview(diff, finding, staticFailures, function(err, aiResult) {
    var decision;
    var allComments = staticFailures.map(function(f) { return '[' + f.id + '] ' + f.message; });
    var lawViolations = [];

    if (aiResult && aiResult.decision !== 'skip') {
      if (aiResult.comments) allComments = allComments.concat(aiResult.comments);
      if (aiResult.law_violations) lawViolations = aiResult.law_violations;
    }

    // Beide Ebenen muessen gruen sein
    if (staticFailures.length > 0) {
      decision = 'request_changes';
    } else if (aiResult && aiResult.decision === 'request_changes') {
      decision = 'request_changes';
    } else {
      decision = 'approve';
    }

    var result = {
      decision: decision,
      comments: allComments,
      static_failures: staticFailures,
      ai_review: aiResult ? {
        decision: aiResult.decision,
        comments: aiResult.comments || [],
        risk_score: aiResult.risk_score || 0,
        summary: aiResult.summary || '',
        pipeline: aiResult._pipeline || null,
        crossCheck: aiResult._crossCheck || null
      } : null,
      law_violations: lawViolations,
      iteration: iteration,
      diff: { files: diff.files, additions: diff.additions, deletions: diff.deletions }
    };

    saveReview(result, findingId, diff, startTime);
    callback(null, result);
  });
}

// ── Review in DB speichern ──────────────────────────────────────

function saveReview(result, findingId, diff, startTime) {
  var duration = Date.now() - startTime;
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  try {
    craDb.run(
      "INSERT INTO review_requests (finding_id, decision, static_failures, ai_decision, ai_comments, law_violations, diff_files, diff_additions, diff_deletions, iteration, review_duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        findingId || null,
        result.decision,
        JSON.stringify(result.static_failures || []),
        result.ai_review ? result.ai_review.decision : null,
        result.ai_review ? JSON.stringify(result.ai_review.comments || []) : null,
        JSON.stringify(result.law_violations || []),
        JSON.stringify(diff.files || []),
        diff.additions || 0,
        diff.deletions || 0,
        result.iteration || 1,
        duration,
        now
      ]
    );
    craDb.saveCraDb();
    console.log('[CRA/Review]', result.decision.toUpperCase(), '— Finding:', findingId || '-', '— Static:', (result.static_failures || []).length, '— AI:', (result.ai_review ? result.ai_review.decision : 'skip'), '— Iteration:', result.iteration, '—', duration + 'ms');
  } catch (e) {
    console.error('[CRA/Review] DB-Fehler:', e.message);
  }
}

// ── Exports ─────────────────────────────────────────────────────

module.exports = {
  evaluate: evaluate,
  parseDiff: parseDiff,
  REVIEW_CRITERIA: REVIEW_CRITERIA
};
