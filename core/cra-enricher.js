// cra-enricher.js — Finding-Anreicherung vor dem Nightworker
// Laeuft taeglich 22:00 CET (90 Min vor Nightworker 23:30)
// Fuer jedes offene Finding ohne konkrete Fix-Anleitung:
//   1. Code auf dem Server greppen
//   2. LLM generiert konkretes Fix-Rezept (Datei, Zeile, Aenderung)
//   3. Finding.fix + Finding.description aktualisieren

var child = require('child_process');
var craDb = require('./cra-db');
var llm = require('../lib/llm'); // LLM-Abstraktion (CRA Plus bindet via MERIDIAN_LLM_ADAPTER opsdesk an)

// ── Config ─────────────────────────────────────────────────────────

var ENRICHER_HOUR = 22;  // 22:00 CET
var CHECK_INTERVAL = 60 * 60 * 1000; // Jede Stunde pruefen ob 22:00

// App → Server-Pfad Mapping
var APP_PATHS = {
  'kurven-schule-buchung': '/home/kurvenschule-kurse/kurse-app',
  'kurse': '/home/kurvenschule-kurse/kurse-app',
  'staging-kurse': '/home/kurvenschule-staging-kurse/htdocs/staging-kurse.kurvenschule.cloud',
  'team': '/home/kurvenschule-team/htdocs/team.kurvenschule.cloud',
  'motopost': '/home/motopost/htdocs/social.kurvenschule.cloud',
  'motokompass': '/home/motokompass-app',
  'kurven-schule-assessment': '/home/kurvenschule-assessment/assessment-app',
  'hvw': '/home/kurvenschule-hvw/htdocs/hvw.kurvenschule.cloud',
  'kursmanager-platform': '/home/kspltf/htdocs/kspltf.kurvenschule.cloud',
  'ks-server-management': '/opt/ks-management',
  'management': '/opt/ks-management',
  'vision-lab': '/home/kurvenschule-vision/htdocs/vision.kurvenschule.cloud',
};

// Meridian: MERIDIAN_APP_PATHS (JSON-Map repo->pfad) ergaenzt/ueberschreibt die
// kursflow-Defaults. Ohne ENV bleiben die Defaults (backward-kompatibel).
if (process.env.MERIDIAN_APP_PATHS) {
  try {
    Object.assign(APP_PATHS, JSON.parse(process.env.MERIDIAN_APP_PATHS));
  } catch (e) {
    console.error('[Enricher] MERIDIAN_APP_PATHS ist kein gueltiges JSON:', e.message);
  }
}

var enricherInterval = null;
var lastRunDate = null;

// ── Haupt-Funktion ─────────────────────────────────────────────────

function enrichFindings() {
  console.log('[Enricher] Starte Finding-Anreicherung...');

  var findings = craDb.all(
    "SELECT id, title, description, fix, severity, apps_json, category " +
    "FROM findings WHERE status = 'open' ORDER BY " +
    "CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END"
  );

  // Nur Findings die noch keine brauchbare Fix-Anleitung haben
  var needsEnrichment = findings.filter(function(f) {
    return !f.fix || f.fix.length < 50;
  });

  if (needsEnrichment.length === 0) {
    console.log('[Enricher] Alle Findings haben Fix-Anleitungen. Nichts zu tun.');
    return;
  }

  console.log('[Enricher] ' + needsEnrichment.length + ' von ' + findings.length + ' Findings brauchen Anreicherung');

  var processed = 0;
  var enrichNext = function() {
    if (processed >= needsEnrichment.length) {
      console.log('[Enricher] Fertig: ' + processed + ' Findings angereichert');
      return;
    }

    var finding = needsEnrichment[processed];
    processed++;

    enrichSingleFinding(finding, function() {
      // 2s Pause zwischen LLM-Calls (Rate-Limiting)
      setTimeout(enrichNext, 2000);
    });
  };

  enrichNext();
}

// ── Einzelnes Finding anreichern ───────────────────────────────────

function enrichSingleFinding(finding, callback) {
  // App-Pfad bestimmen
  var apps = [];
  try { apps = JSON.parse(finding.apps_json || '[]'); } catch(e) {}
  if (typeof apps === 'string') { try { apps = JSON.parse(apps); } catch(e) { apps = [apps]; } }

  var appName = apps[0] || '';
  var appPath = APP_PATHS[appName];

  if (!appPath) {
    console.log('[Enricher] Kein Pfad fuer App "' + appName + '" (' + finding.id + ') — uebersprungen');
    return callback();
  }

  // Code-Kontext sammeln (grep relevante Patterns)
  var codeContext = grepForFinding(finding, appPath);

  if (!codeContext || codeContext.length < 20) {
    console.log('[Enricher] Kein Code-Kontext fuer ' + finding.id + ' — uebersprungen');
    return callback();
  }

  // LLM generiert Fix-Rezept
  var prompt =
    'Du bist ein Security-Engineer der konkrete Fix-Anleitungen fuer einen automatischen Patcher schreibt.\n\n' +
    'FINDING:\n' +
    'ID: ' + finding.id + '\n' +
    'Titel: ' + finding.title + '\n' +
    'Severity: ' + finding.severity + '\n' +
    'App: ' + appName + ' (' + appPath + ')\n' +
    (finding.description ? 'Beschreibung: ' + finding.description + '\n' : '') +
    '\nRELEVANTER CODE:\n' + codeContext + '\n\n' +
    'Schreibe eine KONKRETE Fix-Anleitung die ein LLM-Patcher umsetzen kann.\n' +
    'Format:\n' +
    'DATEI: <exakter Pfad>\n' +
    'PROBLEM: <was genau falsch ist, 1 Satz>\n' +
    'FIX: <was genau geaendert werden muss, mit Code-Snippet>\n' +
    'RISIKO: <was schiefgehen kann beim Patchen>\n\n' +
    'Sei KONKRET: Dateinamen, Zeilennummern, exakter Code. Keine vagen Empfehlungen.';

  llm.ask(prompt, { maxTokens: 800 }, function(response) {
    if (!response || response.length < 30) {
      console.log('[Enricher] LLM-Antwort leer fuer ' + finding.id);
      return callback();
    }

    // Fix-Feld aktualisieren
    var currentDesc = finding.description || '';
    var enrichedDesc = currentDesc + (currentDesc ? '\n\n' : '') +
      '--- Enricher (' + new Date().toISOString().substring(0, 10) + ') ---\n' + response.substring(0, 500);

    craDb.run(
      "UPDATE findings SET fix = ?, description = ? WHERE id = ?",
      [response.substring(0, 1000), enrichedDesc.substring(0, 2000), finding.id]
    );

    console.log('[Enricher] ' + finding.id + ' angereichert (' + response.length + ' Zeichen)');
    callback();
  });
}

// ── Code-Kontext per grep sammeln ──────────────────────────────────

function grepForFinding(finding, appPath) {
  var patterns = extractGrepPatterns(finding);
  var results = [];

  for (var i = 0; i < patterns.length && results.length < 500; i++) {
    try {
      var cmd = "grep -rn " + shellEscape(patterns[i]) + " " + shellEscape(appPath + '/') +
        " --include='*.js' --include='*.ts' --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -15";
      var output = child.execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
      if (output) results.push('# grep "' + patterns[i] + '":\n' + output);
    } catch(e) { /* grep fand nichts oder Timeout */ }
  }

  // Fallback: package.json fuer npm-Findings
  if (finding.id.indexOf('NW-DEP-') === 0) {
    try {
      var auditCmd = "cd " + shellEscape(appPath) + " && npm audit --json 2>/dev/null | head -100";
      var auditOut = child.execSync(auditCmd, { encoding: 'utf8', timeout: 15000 }).trim();
      if (auditOut) results.push('# npm audit:\n' + auditOut.substring(0, 500));
    } catch(e) {}
  }

  return results.join('\n\n');
}

function extractGrepPatterns(finding) {
  var title = (finding.title || '').toLowerCase();
  var patterns = [];

  // Pattern-Erkennung aus Finding-Titel
  if (title.indexOf('rate-limit') >= 0 || title.indexOf('rate limit') >= 0)
    patterns.push('app\\.get\\|app\\.post\\|app\\.put\\|app\\.delete', 'rateLimit\\|rateLimiter\\|express-rate-limit');
  if (title.indexOf('parseint') >= 0 || title.indexOf('parameter') >= 0)
    patterns.push('parseInt(req\\.', 'req\\.params\\|req\\.query');
  if (title.indexOf('session') >= 0)
    patterns.push('session\\[\\|sessions\\[\\|req\\.session', 'cookie.*sid\\|ks_sid');
  if (title.indexOf('csp') >= 0 || title.indexOf('header') >= 0)
    patterns.push('Content-Security-Policy\\|helmet\\|writeHead', 'setHeader');
  if (title.indexOf('error') >= 0 || title.indexOf('sensitive') >= 0 || title.indexOf('log') >= 0)
    patterns.push('console\\.error\\|console\\.log', 'catch.*err\\|stack\\|message');
  if (title.indexOf('auth') >= 0)
    patterns.push('requireAuth\\|requireAdmin\\|authed', 'app\\.post.*api\\|app\\.get.*api');
  if (title.indexOf('debug') >= 0 || title.indexOf('health') >= 0)
    patterns.push('/api/health\\|/api/debug', 'NODE_ENV\\|production');
  if (title.indexOf('input') >= 0 || title.indexOf('validier') >= 0)
    patterns.push('req\\.body\\|req\\.params\\|req\\.query', 'sanitize\\|validate');
  if (title.indexOf('npm') >= 0 || title.indexOf('vuln') >= 0)
    patterns.push(''); // npm audit handled separately

  // Fallback: Keywords aus Titel
  if (patterns.length === 0) {
    var words = title.split(/\s+/).filter(function(w) { return w.length > 4; });
    patterns = words.slice(0, 3);
  }

  return patterns.filter(function(p) { return p.length > 0; });
}

function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Timer: Taeglich um 22:00 CET ──────────────────────────────────

function checkAndRun() {
  var now = new Date();
  // CET = UTC+1 (Winter) / UTC+2 (Sommer) — vereinfacht UTC+2
  var cetHour = (now.getUTCHours() + 2) % 24;
  var today = now.toISOString().substring(0, 10);

  if (cetHour === ENRICHER_HOUR && lastRunDate !== today) {
    lastRunDate = today;
    console.log('[Enricher] 22:00 CET — Starte taegliche Anreicherung');
    try { enrichFindings(); } catch(e) {
      console.error('[Enricher] Fehler:', e.message);
    }
  }
}

function start() {
  console.log('[Enricher] Gestartet (taeglich ' + ENRICHER_HOUR + ':00 CET, 90 Min vor Nightworker)');
  enricherInterval = setInterval(checkAndRun, CHECK_INTERVAL);
  // Erster Check nach 30s
  setTimeout(checkAndRun, 30000);
}

function stop() {
  if (enricherInterval) clearInterval(enricherInterval);
  enricherInterval = null;
  console.log('[Enricher] Gestoppt');
}

module.exports = {
  start: start,
  stop: stop,
  enrichFindings: enrichFindings,  // Manueller Trigger
  enrichSingleFinding: enrichSingleFinding,
};
