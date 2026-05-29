// admin/cra/cra-dispatcher.js — Autonomous Dispatch Loop (CommonJS)
// Steuert autonome Claude Code Sessions basierend auf FSC + Finding-Katalog
var https = require('https');
var crypto = require('crypto');
var craDb = require('./cra-db');
var craFsc = require('./cra-fsc');
var craRules = require('./cra-rules');
var deploySafety = require('./cra-deploy-safety');

var DISPATCH_INTERVAL_MS = 5 * 60 * 1000;   // 5 Minuten
var FSC_CHECK_INTERVAL_MS = 60 * 1000;       // 1 Minute
var SESSION_TIMEOUT_MS = 20 * 60 * 1000;     // 20 Minuten ohne Heartbeat
var DAILY_SUMMARY_HOUR = 6;                   // 06:00 UTC

var dispatchTimer = null;
var fscTimer = null;
var running = false;
var lastDailySummary = null;

// ── Dispatch-Loop starten ───────────────────────────────────────

function start() {
  if (running) return { ok: false, error: 'Dispatcher laeuft bereits' };
  running = true;

  // FSC-Status alle 60s aktualisieren
  fscTimer = setInterval(function() {
    craFsc.refreshStatuses();
    checkExpiredSessions();
  }, FSC_CHECK_INTERVAL_MS);

  // Dispatch alle 5 Min
  dispatchTimer = setInterval(function() {
    craFsc.autoGenerate(); // Auto-FSC wenn Backlog > Threshold
    dispatchNext();
    checkDailySummary();
  }, DISPATCH_INTERVAL_MS);

  // Sofort einmal ausfuehren
  craFsc.refreshStatuses();
  console.log('[CRA/Dispatcher] Gestartet — Intervall:', DISPATCH_INTERVAL_MS / 1000, 's');
  return { ok: true, status: 'running' };
}

function stop() {
  if (!running) return { ok: false, error: 'Dispatcher laeuft nicht' };
  if (dispatchTimer) clearInterval(dispatchTimer);
  if (fscTimer) clearInterval(fscTimer);
  dispatchTimer = null;
  fscTimer = null;
  running = false;
  console.log('[CRA/Dispatcher] Gestoppt');
  return { ok: true, status: 'stopped' };
}

// ── Status ──────────────────────────────────────────────────────

function getStatus() {
  var activeSession = getActiveSession();
  var fscCurrent = craFsc.getCurrent();
  var nextFinding = getNextFinding();
  var todaySessions = craDb.all(
    "SELECT * FROM dispatch_sessions WHERE started_at >= ? ORDER BY started_at DESC",
    [new Date().toISOString().split('T')[0]]
  );

  var safety = deploySafety.getStatus();

  var rules = craRules.loadRules();
  var autostart = rules && rules.auto_fsc && rules.auto_fsc.dispatcher_autostart;

  return {
    running: running,
    autostart: !!autostart,
    active_session: activeSession,
    circuit_breaker: safety.circuit_breaker,
    fsc_active: !!fscCurrent,
    fsc_window: fscCurrent ? { id: fscCurrent.id, type: fscCurrent.type, ends_at: fscCurrent.ends_at } : null,
    next_finding: nextFinding ? { id: nextFinding.id, title: nextFinding.title, severity: nextFinding.severity } : null,
    sessions_today: {
      total: todaySessions.length,
      completed: todaySessions.filter(function(s) { return s.status === 'completed'; }).length,
      failed: todaySessions.filter(function(s) { return s.status === 'failed'; }).length,
      active: todaySessions.filter(function(s) { return s.status === 'running'; }).length
    }
  };
}

// ── Entscheidungsbaum ───────────────────────────────────────────

function dispatchNext(opts) {
  // 0. Circuit Breaker
  var cb = deploySafety.checkCircuitBreaker();
  if (cb.tripped) {
    stop(); // Dispatcher automatisch stoppen
    return { dispatched: false, reason: 'CIRCUIT BREAKER: ' + cb.consecutive_failures + ' Failures hintereinander — Dispatcher gestoppt' };
  }

  // 1. Aktive Session vorhanden?
  var active = getActiveSession();
  if (active) {
    return { dispatched: false, reason: 'Aktive Session: ' + active.id };
  }

  // 2. FSC-Fenster aktiv?
  craFsc.refreshStatuses();
  var fsc = craFsc.getCurrent();
  if (!fsc) {
    return { dispatched: false, reason: 'Kein aktives FSC-Fenster' };
  }

  // 3. Naechstes offenes Finding (ueberspringe blockierte)
  var allFindings = getAllOpenFindings();
  if (!allFindings.length) {
    return { dispatched: false, reason: 'Keine offenen Findings' };
  }

  var finding = null;
  var skipReasons = [];
  for (var fi = 0; fi < allFindings.length; fi++) {
    var candidate = allFindings[fi];

    // 4. Critical ohne emergency-Flag → skip, naechstes versuchen
    if (candidate.severity === 'CRITICAL' && fsc.type !== 'emergency') {
      skipReasons.push(candidate.id + ': Critical ohne Emergency');
      continue;
    }

    // 5. Abhaengigkeiten pruefen
    var depBlocked = false;
    if (candidate.depends_on) {
      try {
        var deps = JSON.parse(candidate.depends_on);
        for (var di = 0; di < deps.length; di++) {
          var dep = craDb.get("SELECT status FROM findings WHERE id = ?", [deps[di]]);
          if (!dep || dep.status !== 'fixed') { depBlocked = true; break; }
        }
      } catch (e) { /* keine deps */ }
    }
    if (depBlocked) { skipReasons.push(candidate.id + ': Abhaengigkeit'); continue; }

    // 6. Retry-Limit: zu oft fehlgeschlagen → eskalieren, naechstes Finding
    var failedSessions = craDb.get(
      "SELECT COUNT(*) as c FROM dispatch_sessions WHERE finding_id = ? AND status = 'failed'",
      [candidate.id]
    );
    var failCount = (failedSessions && failedSessions.c) || 0;
    var rules = craRules.loadRules();
    var retryLimits = (rules && rules.auto_fsc && rules.auto_fsc.max_retries_by_severity) || {};
    var maxRetries = retryLimits[candidate.severity] || retryLimits['MEDIUM'] || 3;
    if (failCount >= maxRetries) {
      // Finding eskalieren — kein weiterer automatischer Versuch
      craDb.run("UPDATE findings SET status = 'escalated', updated_at = ? WHERE id = ?",
        [new Date().toISOString().replace('T', ' ').split('.')[0], candidate.id]);
      craDb.saveCraDb();
      console.log('[CRA/Dispatcher] Finding eskaliert (max retries):', candidate.id, '— Failures:', failCount, '/', maxRetries);
      logDispatchEvent('finding-escalated', candidate.id, failCount + '/' + maxRetries + ' Failures — automatisch eskaliert');
      skipReasons.push(candidate.id + ': Eskaliert (' + failCount + '/' + maxRetries + ' Failures)');
      continue;
    }

    finding = candidate;
    break;
  }

  if (!finding) {
    return { dispatched: false, reason: 'Alle Findings blockiert (' + skipReasons.join(', ') + ')', skipped: skipReasons };
  }

  // 6. Fenster-Restzeit pruefen (min 60 Min fuer neuen Start)
  var endsAt = new Date(fsc.ends_at.replace(' ', 'T') + 'Z');
  var remainMin = (endsAt - Date.now()) / 60000;
  if (remainMin < 60) {
    return { dispatched: false, reason: 'Weniger als 60 Min im Fenster (' + Math.round(remainMin) + ' Min)' };
  }

  // 7. Session starten (oder dry_run)
  if (opts && opts.dry_run) {
    return { dispatched: false, dry_run: true, would_dispatch: finding.id, fsc_window: fsc.id, reason: 'dry_run — keine Session erstellt' };
  }
  return startSession(finding, fsc);
}

// ── Session starten ─────────────────────────────────────────────

function startSession(finding, fscWindow) {
  var sessionId = 'SES-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];

  // Session als 'queued' erstellen (nicht 'running' — Worker setzt auf running)
  craDb.run(
    "INSERT INTO dispatch_sessions (id, finding_id, fsc_window_id, status, started_at, last_heartbeat, trigger_mode) VALUES (?,?,?,?,?,?,?)",
    [sessionId, finding.id, fscWindow.id, 'queued', now, now, 'worker']
  );

  // Task in Worker-Queue eintragen
  craDb.run(
    "INSERT INTO claude_tasks (finding_id, status, created_at) VALUES (?, 'pending', datetime('now','localtime'))",
    [finding.id]
  );

  craDb.saveCraDb();

  console.log('[CRA/Dispatcher] Finding gequeued:', finding.id, '— Session:', sessionId, '(Worker holt ab)');
  logDispatchEvent('session-queued', finding.id, sessionId + ' → worker');

  return { dispatched: true, session_id: sessionId, finding_id: finding.id, fsc_window: fscWindow.id };
}

// ── Claude Code triggern ────────────────────────────────────────

function triggerClaudeCode(sessionId, finding, fscWindow) {
  var triggerId = process.env.CRA_CLAUDE_TRIGGER_ID;
  var apiKey = process.env.ANTHROPIC_API_KEY;

  if (!triggerId || !apiKey) {
    console.log('[CRA/Dispatcher] Kein Trigger konfiguriert — Session bleibt in Queue');
    // Task in claude_tasks eintragen als Fallback
    craDb.run(
      "INSERT INTO claude_tasks (finding_id, status, created_at) VALUES (?, 'pending', datetime('now','localtime'))",
      [finding.id]
    );
    craDb.saveCraDb();
    return;
  }

  var body = JSON.stringify({
    prompt: buildInstructions(finding, fscWindow, sessionId)
  });

  var req = https.request({
    hostname: 'api.anthropic.com',
    path: '/v1/code/triggers/' + triggerId + '/run',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    }
  }, function(res) {
    var data = '';
    res.on('data', function(c) { data += c; });
    res.on('end', function() {
      console.log('[CRA/Dispatcher] Trigger gefeuert:', sessionId, '— Status:', res.statusCode);
      logDispatchEvent('trigger-fired', finding.id, sessionId + ' → ' + triggerId);
    });
  });

  req.on('error', function(e) {
    console.error('[CRA/Dispatcher] Trigger-Fehler:', e.message);
    logDispatchEvent('trigger-error', finding.id, e.message);
  });

  req.setTimeout(15000, function() { req.destroy(); });
  req.write(body);
  req.end();
}

function buildInstructions(finding, fscWindow, sessionId) {
  return [
    'Security Remediation Session.',
    'Session-ID: ' + sessionId,
    'Finding-ID: ' + finding.id,
    'Severity: ' + (finding.severity || 'MEDIUM'),
    'Title: ' + (finding.title || ''),
    'FSC-Fenster: ' + fscWindow.id + ' (gueltig bis ' + fscWindow.ends_at + ')',
    '',
    'Arbeite Finding ' + finding.id + ' gemaess CLAUDE-security-pipeline.md ab.',
    'Sende Heartbeat: POST /api/cra/dispatcher/heartbeat mit session_id.',
    'Nach Abschluss: POST /api/cra/dispatcher/complete mit session_id + result.'
  ].join('\n');
}

// ── Session-Management ──────────────────────────────────────────

function getActiveSession() {
  return craDb.get("SELECT * FROM dispatch_sessions WHERE status IN ('running','queued') LIMIT 1");
}

function heartbeat(sessionId) {
  var session = craDb.get("SELECT * FROM dispatch_sessions WHERE id = ?", [sessionId]);
  if (!session) return { ok: false, error: 'Session nicht gefunden' };
  if (session.status !== 'running') return { ok: false, error: 'Session nicht aktiv: ' + session.status };

  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  craDb.run("UPDATE dispatch_sessions SET last_heartbeat = ? WHERE id = ?", [now, sessionId]);
  craDb.saveCraDb();
  return { ok: true, session_id: sessionId };
}

function completeSession(sessionId, result, errorMessage) {
  var session = craDb.get("SELECT * FROM dispatch_sessions WHERE id = ?", [sessionId]);
  if (!session) return { ok: false, error: 'Session nicht gefunden' };

  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  var status = (result === 'failed' || result === 'escalated') ? result : 'completed';

  craDb.run(
    "UPDATE dispatch_sessions SET status = ?, completed_at = ?, result = ?, error_message = ? WHERE id = ?",
    [status, now, result || 'resolved', errorMessage || null, sessionId]
  );

  // Finding-Status: Gate-basiert bestimmen
  if (session.finding_id && result === 'resolved') {
    var gates = checkGates(session.finding_id);

    // Auto-Review triggern wenn noch keiner existiert
    if (gates.review === 'none') {
      try {
        var craReview = require('./cra-review-engine');
        var finding = craDb.get('SELECT * FROM findings WHERE id = ?', [session.finding_id]);
        if (finding) {
          craReview.evaluate({
            finding_id: session.finding_id,
            finding: finding,
            diff: '',
            context: 'Auto-Review nach Worker-Session ' + sessionId
          }, function(err, reviewResult) {
            if (reviewResult) {
              console.log('[CRA/Dispatcher] Auto-Review:', session.finding_id, '→', reviewResult.decision);
              logDispatchEvent('auto-review', session.finding_id, reviewResult.decision);
            }
          });
        }
      } catch (e) { /* Review-Engine optional */ }
    }

    var findingStatus = gates.all_passed ? 'fixed' : 'staging-deployed';
    craDb.run("UPDATE findings SET status = ?, updated_at = ? WHERE id = ?", [findingStatus, now, session.finding_id]);
    if (!gates.all_passed) {
      logDispatchEvent('gate-pending', session.finding_id, 'Review: ' + gates.review + ', Tests: ' + gates.tests);
    }
  } else if (session.finding_id) {
    craDb.run("UPDATE findings SET status = 'open', updated_at = ? WHERE id = ?", [now, session.finding_id]);
  }

  craDb.saveCraDb();
  console.log('[CRA/Dispatcher] Session abgeschlossen:', sessionId, '— Result:', result);
  logDispatchEvent('session-complete', session.finding_id, sessionId + ': ' + result);
  return { ok: true, session_id: sessionId, status: status };
}

// ── Gate-Checks: Review + Tests ─────────────────────────────────

function checkGates(findingId) {
  var result = { review: 'pending', tests: 'pending', all_passed: false };

  // Review-Gate: Letzter Review für dieses Finding
  var lastReview = craDb.get(
    "SELECT decision FROM review_requests WHERE finding_id = ? ORDER BY created_at DESC LIMIT 1",
    [findingId]
  );
  result.review = lastReview ? lastReview.decision : 'none';

  // Test-Gate: Letzter Test-Job für dieses Finding
  var lastTest = craDb.get(
    "SELECT status FROM test_jobs WHERE finding_id = ? ORDER BY started_at DESC LIMIT 1",
    [findingId]
  );
  result.tests = lastTest ? lastTest.status : 'none';

  // Beide müssen bestanden sein
  result.all_passed = (result.review === 'approve' || result.review === 'none')
                   && (result.tests === 'pass' || result.tests === 'none');

  return result;
}

function checkExpiredSessions() {
  var cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString().replace('T', ' ').split('.')[0];
  var expired = craDb.all(
    "SELECT * FROM dispatch_sessions WHERE status IN ('running', 'queued') AND last_heartbeat < ?",
    [cutoff]
  );

  expired.forEach(function(s) {
    console.log('[CRA/Dispatcher] Session timeout:', s.id, '— Letzter Heartbeat:', s.last_heartbeat);
    completeSession(s.id, 'failed', 'Session-Timeout (kein Heartbeat seit 20 Min)');
    logDispatchEvent('session-timeout', s.finding_id, s.id);
  });
}

// ── Naechstes Finding ───────────────────────────────────────────

function getNextFinding() {
  var all = getAllOpenFindings();
  return all.length > 0 ? all[0] : null;
}

function getAllOpenFindings() {
  var severityOrder = "CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END";
  return craDb.all(
    "SELECT * FROM findings WHERE status = 'open' ORDER BY " + severityOrder + ", created_at ASC LIMIT 20"
  );
}

// Findings die auf Staging verifiziert wurden und für Prod-Deploy bereit sind
function getStagingVerifiedFindings() {
  return craDb.all(
    "SELECT * FROM findings WHERE status = 'staging-verified' ORDER BY created_at ASC LIMIT 10"
  );
}

// Prüfe ob das aktuelle FSC-Fenster Prod-Deploys erlaubt
function canDeployProd() {
  var fsc = craFsc.getCurrent();
  if (!fsc) return { allowed: false, reason: 'Kein aktives FSC-Fenster' };
  var targets = [];
  try { targets = JSON.parse(fsc.allowed_targets || '[]'); } catch (e) {}
  // Prod-Target-Namen aus ENV (CRA Plus: MERIDIAN_PROD_TARGETS; OSS-Default 'production').
  var prodTargets = (process.env.MERIDIAN_PROD_TARGETS || 'production').split(',').map(function (s) { return s.trim(); });
  if (!prodTargets.some(function (t) { return targets.includes(t); })) {
    return { allowed: false, reason: 'Fenster erlaubt nur: ' + targets.join(', ') };
  }
  return { allowed: true, window: fsc };
}

// ── Alle Sessions ───────────────────────────────────────────────

function getSessions(limit) {
  return craDb.all(
    'SELECT * FROM dispatch_sessions ORDER BY started_at DESC LIMIT ?',
    [limit || 50]
  );
}

// ── Daily Summary ───────────────────────────────────────────────

function checkDailySummary() {
  var now = new Date();
  var hour = now.getUTCHours();
  var today = now.toISOString().split('T')[0];

  if (hour === DAILY_SUMMARY_HOUR && lastDailySummary !== today) {
    lastDailySummary = today;
    generateDailySummary(today);
  }
}

function generateDailySummary(date) {
  var yesterday = new Date(new Date(date).getTime() - 86400000).toISOString().split('T')[0];

  var sessions = craDb.all(
    "SELECT * FROM dispatch_sessions WHERE started_at >= ? AND started_at < ?",
    [yesterday, date]
  );
  var findings = craDb.all("SELECT * FROM findings");
  var tests = craDb.all(
    "SELECT * FROM test_runs WHERE created_at >= ? AND created_at < ?",
    [yesterday, date]
  );
  var fscWindows = craDb.all(
    "SELECT * FROM fsc_windows WHERE starts_at >= ? OR ends_at >= ?",
    [yesterday, yesterday]
  );

  var summary = {
    date: yesterday,
    findings: {
      total: findings.length,
      open: findings.filter(function(f) { return f.status === 'open'; }).length,
      in_progress: findings.filter(function(f) { return f.status === 'in_progress'; }).length,
      fixed: findings.filter(function(f) { return f.status === 'fixed'; }).length
    },
    sessions: {
      total: sessions.length,
      completed: sessions.filter(function(s) { return s.status === 'completed'; }).length,
      failed: sessions.filter(function(s) { return s.status === 'failed'; }).length
    },
    tests: {
      total: tests.length,
      passed: tests.filter(function(t) { return t.failed === 0; }).length,
      failed: tests.filter(function(t) { return t.failed > 0; }).length
    },
    fsc_windows_used: fscWindows.filter(function(w) { return w.status === 'closed' || w.status === 'active'; }).length
  };

  // In Monitor-Runs speichern
  craDb.run(
    "INSERT INTO monitor_runs (script_name, status, summary, report_json, triggered_by) VALUES (?,?,?,?,?)",
    ['daily-summary', 'ok', 'Daily Summary ' + yesterday, JSON.stringify(summary), 'cra-dispatcher']
  );
  craDb.saveCraDb();

  console.log('[CRA/Dispatcher] Daily Summary:', JSON.stringify(summary));
  return summary;
}

// ── Hilfsfunktionen ─────────────────────────────────────────────

function logDispatchEvent(eventType, findingId, details) {
  craDb.run(
    'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
    ['cra-dispatcher', eventType, null, findingId || null, details || null]
  );
  craDb.saveCraDb();
}


// ── Worker-API: Atomares Pickup + Completion ───────────────────

function pickTask() {
  // 1. Circuit Breaker
  var cb = deploySafety.checkCircuitBreaker();
  if (cb.tripped) {
    return { ok: false, reason: 'CIRCUIT BREAKER aktiv (' + cb.consecutive_failures + ' Failures)' };
  }

  // 2. FSC-Fenster aktiv?
  craFsc.refreshStatuses();
  var fsc = craFsc.getCurrent();
  if (!fsc) {
    return { ok: false, reason: 'Kein aktives FSC-Fenster' };
  }

  // 3. Bereits aktive Worker-Session?
  var active = getActiveSession();
  if (active) {
    return { ok: false, reason: 'Aktive Session: ' + active.id };
  }

  // 4. Naechsten pending Task holen
  var task = craDb.get(
    "SELECT t.id as task_id, t.finding_id, f.title, f.severity, f.description, f.fix, f.lesson, f.apps_json, f.category " +
    "FROM claude_tasks t LEFT JOIN findings f ON t.finding_id = f.id " +
    "WHERE t.status = 'pending' ORDER BY t.id ASC LIMIT 1"
  );
  if (!task) {
    return { ok: false, reason: 'Keine pending Tasks' };
  }

  // 5. App + Workdir aus cra-rules.json auflösen
  var appName = '';
  try {
    var appsRaw = task.apps_json || '[]';
    var apps = JSON.parse(appsRaw);
    if (typeof apps === 'string') apps = JSON.parse(apps);
    if (Array.isArray(apps) && apps.length > 0) appName = apps[0];
    else appName = String(apps);
  } catch (e) { appName = String(task.apps_json || '').replace(/[\[\]"]/g, ''); }

  var rules = craRules.loadRules();
  var appConfig = null;
  if (rules && rules.apps) {
    for (var i = 0; i < rules.apps.length; i++) {
      if (rules.apps[i].id === appName) { appConfig = rules.apps[i]; break; }
    }
  }
  var workdir = (appConfig && appConfig.staging_dir) || '';
  if (!workdir || workdir === '-') {
    // Fallback: ks-server-management sonderfall
    if (appName === 'ks-server-management' || appName === 'management') workdir = process.env.MERIDIAN_BASE_PATH || '/opt/ks-management';
    else return { ok: false, reason: 'Kein staging_dir fuer App: ' + appName, task_id: task.task_id };
  }

  // 6. App-User aus Workdir ableiten
  var appUser = 'root';
  var m = workdir.match(/^\/home\/([^/]+)\//);
  if (m) appUser = m[1];

  // 7. Session + Task atomar aktualisieren (DB-Transaktion)
  var sessionId = 'SES-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];

  // Sandbox-Pruefung: Workdir muss in erlaubtem Basisverzeichnis liegen
  var path = require('path');
  var resolvedDir = path.resolve(workdir);
  var allowedBases = ['/home/', '/opt/'];
  var inSandbox = allowedBases.some(function(base) { return resolvedDir.startsWith(base); });
  if (!inSandbox) {
    return { ok: false, reason: 'Workdir ausserhalb der Sandbox: ' + workdir, task_id: task.task_id };
  }

  craDb.transaction(function() {
    craDb.run(
      "INSERT INTO dispatch_sessions (id, finding_id, fsc_window_id, status, started_at, last_heartbeat, trigger_mode) VALUES (?,?,?,?,?,?,?)",
      [sessionId, task.finding_id, fsc.id, 'running', now, now, 'worker']
    );
    craDb.run(
      "UPDATE claude_tasks SET status = 'picked', picked_at = ? WHERE id = ?",
      [now, task.task_id]
    );
  });
  craDb.saveCraDb();

  console.log('[CRA/Worker] Task picked:', task.task_id, task.finding_id, '— Session:', sessionId, '— App:', appName);
  logDispatchEvent('worker-pick', task.finding_id, sessionId + ' Task#' + task.task_id);

  // 8. Prompt generieren
  var prompt = buildWorkerPrompt(task, appName, workdir, sessionId);

  return {
    ok: true,
    task_id: task.task_id,
    session_id: sessionId,
    finding_id: task.finding_id,
    app: appName,
    workdir: workdir,
    app_user: appUser,
    fsc_window: fsc.id,
    fsc_ends_at: fsc.ends_at,
    prompt: prompt
  };
}

function buildWorkerPrompt(task, appName, workdir, sessionId) {
  var craBase = process.env.CRA_BASE_URL || 'http://localhost:3011';
  var craHeader = 'X-CRA-Token: ' + (process.env.CRA_API_TOKEN || '');

  // Check DB fuer App-spezifisches Override
  var override = null;
  try {
    override = craDb.get(
      "SELECT template FROM prompt_templates WHERE app_name = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1",
      [appName]
    );
  } catch (e) { /* Tabelle existiert evtl. noch nicht */ }

  // Default-Template (oder Override)
  var rules = craRules.loadRules();
  var template = (override && override.template) ||
    (rules && rules.auto_fsc && rules.auto_fsc.worker_prompt_template) ||
    getDefaultPromptTemplate();

  // Platzhalter ersetzen
  var taskJson = JSON.stringify({
    finding_id: task.finding_id,
    title: task.title,
    severity: task.severity,
    description: task.description,
    fix: task.fix,
    lesson: task.lesson,
    category: task.category
  }, null, 2);

  // Relevante Code-Patterns aus dem Repository laden
  var patternsText = 'Keine relevanten Patterns gefunden.';
  try {
    var category = task.category || '';
    var title = task.title || '';
    var searchTerms = [category, title.split(' ')[0], appName].filter(Boolean);
    var patterns = [];
    for (var si = 0; si < searchTerms.length && patterns.length < 3; si++) {
      var term = '%' + searchTerms[si] + '%';
      var found = craDb.all(
        "SELECT pattern_name, description, code_snippet FROM code_repository WHERE (repo = ? OR pattern_name LIKE ? OR description LIKE ? OR tags_json LIKE ?) AND code_snippet IS NOT NULL ORDER BY usage_count DESC LIMIT 3",
        [appName, term, term, term]
      );
      for (var fi = 0; fi < found.length; fi++) {
        if (!patterns.some(function(p) { return p.pattern_name === found[fi].pattern_name; })) {
          patterns.push(found[fi]);
        }
      }
    }
    if (patterns.length > 0) {
      var lines = ['Relevante Fix-Patterns aus dem Code-Repository:'];
      for (var pi = 0; pi < patterns.length; pi++) {
        lines.push('');
        lines.push('--- Pattern: ' + patterns[pi].pattern_name + ' ---');
        lines.push(patterns[pi].description || '');
        lines.push(patterns[pi].code_snippet || '');
      }
      patternsText = lines.join('\n');
      // Usage-Count erhoehen
      for (var ui = 0; ui < patterns.length; ui++) {
        craDb.run("UPDATE code_repository SET usage_count = usage_count + 1 WHERE pattern_name = ?", [patterns[ui].pattern_name]);
      }
      craDb.saveCraDb();
    }
  } catch (e) { /* code_repository optional */ }

  return template
    .replace(/FINDING_PLACEHOLDER/g, task.finding_id || '')
    .replace(/TASK_PLACEHOLDER/g, String(task.task_id || ''))
    .replace(/TITLE_PLACEHOLDER/g, task.title || '')
    .replace(/APP_PLACEHOLDER/g, appName)
    .replace(/WORKDIR_PLACEHOLDER/g, workdir)
    .replace(/SESSION_PLACEHOLDER/g, sessionId)
    .replace(/CRA_PLACEHOLDER/g, craBase)
    .replace(/CRA_HEADER/g, craHeader)
    .replace(/TASKJSON_PLACEHOLDER/g, taskJson)
    .replace(/PATTERNS_PLACEHOLDER/g, patternsText);
}

function getDefaultPromptTemplate() {
  return [
    'Du bist ein CRA-Finding-Worker fuer kurven.schule.',
    'Arbeite den folgenden Task EXAKT nach diesem Ablauf ab:',
    '',
    '=== TASK-DETAILS ===',
    'Finding-ID: FINDING_PLACEHOLDER',
    'Task-ID: TASK_PLACEHOLDER',
    'Session-ID: SESSION_PLACEHOLDER',
    'Titel: TITLE_PLACEHOLDER',
    'App: APP_PLACEHOLDER',
    'Arbeitsverzeichnis: WORKDIR_PLACEHOLDER',
    '',
    'Task-JSON:',
    'TASKJSON_PLACEHOLDER',
    '',
    '=== ABLAUF (STRIKT EINHALTEN) ===',
    '',
    'SCHRITT 1: Vorbereitung',
    '- cd WORKDIR_PLACEHOLDER',
    '- git checkout staging || git checkout -b staging',
    '- git pull origin staging 2>/dev/null || true',
    '',
    'SCHRITT 1b: Relevante Fix-Patterns pruefen',
    'PATTERNS_PLACEHOLDER',
    'Wenn Patterns vorhanden: als Referenz nutzen (nicht blind kopieren).',
    'Passe den Ansatz an die konkrete Codebasis an.',
    '',
    'SCHRITT 2: Fix implementieren',
    '- Lies die Task-Details (title, description, fix)',
    '- Implementiere den Fix gemaess description/fix',
    '- Nutze relevante Patterns aus Schritt 1b als Orientierung',
    '- Halte dich an bestehende Code-Konventionen',
    '- Aendere NUR was noetig ist (kein Scope-Creep)',
    '',
    'SCHRITT 3: CRA-Analyse VOR dem Commit',
    'curl -s -X POST CRA_PLACEHOLDER/api/cra/analyze \\',
    '  -H "CRA_HEADER" -H "Content-Type: application/json" \\',
    '  -d "{\\"repoName\\":\\"APP_PLACEHOLDER\\",\\"commitMessage\\":\\"...\\",\\"branch\\":\\"staging\\",\\"diffSource\\":\\"local\\",\\"diff\\":\\"$(git diff)\\"}"',
    '',
    'Wenn BLOCKED: Fix anpassen und nochmal analysieren (max 2 Versuche).',
    '',
    'SCHRITT 4: Code-Review anfordern',
    'curl -s -X POST CRA_PLACEHOLDER/api/cra/review/request \\',
    '  -H "CRA_HEADER" -H "Content-Type: application/json" \\',
    '  -d "{\\"finding_id\\":\\"FINDING_PLACEHOLDER\\",\\"diff\\":\\"$(git diff)\\",\\"context\\":\\"Fix fuer FINDING_PLACEHOLDER\\"}"',
    '',
    'Pruefe das Ergebnis:',
    '- "approve" -> weiter zu Schritt 5',
    '- "request_changes" -> Aenderungen einarbeiten, zurueck zu Schritt 2 (max 3 Iterationen)',
    '- "escalate" -> Task als failed markieren, Schritt 7',
    '',
    'SCHRITT 5: git commit + push',
    '- git add -A',
    '- git commit -m "fix: FINDING_PLACEHOLDER — TITLE_PLACEHOLDER"',
    '- git push origin staging',
    '',
    'SCHRITT 5b: Code-Pattern speichern (wenn Fix wiederverwendbar)',
    'Wenn der Fix ein allgemeines Muster loest (security, auth, validation, XSS, etc.):',
    'curl -s -X POST CRA_PLACEHOLDER/api/cra/code-repo \\',
    '  -H "CRA_HEADER" -H "Content-Type: application/json" \\',
    '  -d "{\\"repo\\":\\"APP_PLACEHOLDER\\",\\"pattern_name\\":\\"kurzer-name\\",\\"description\\":\\"Was wurde gefixt und warum\\",\\"code_snippet\\":\\"// VORHER (vulnerable):\\n...\\n// NACHHER (safe):\\n...\\",\\"tags_json\\":\\"[\\\\\\"security\\\\\\",\\\\\\"FINDING_PLACEHOLDER\\\\\\"]\\",\\"meta_json\\":\\"{\\\\\\"problem\\\\\\":\\\\\\"...\\\\\\",\\\\\\"solution\\\\\\":\\\\\\"...\\\\\\"}\\"}"',
    '',
    'Speichere ein Pattern wenn:',
    '- Der Fix ein allgemeines Muster loest (XSS, injection, auth, validation)',
    '- Der Fix auf andere Apps uebertragbar waere',
    'Speichere KEIN Pattern wenn der Fix sehr spezifisch/einmalig ist.',
    '',
    'SCHRITT 6: Heartbeat + Completion melden',
    'curl -s -X POST CRA_PLACEHOLDER/api/cra/worker/heartbeat \\',
    '  -H "CRA_HEADER" -H "Content-Type: application/json" \\',
    '  -d "{\\"session_id\\":\\"SESSION_PLACEHOLDER\\"}"',
    '',
    'SCHRITT 7: Task abschliessen',
    'Bei Erfolg:',
    'curl -s -X POST CRA_PLACEHOLDER/api/cra/worker/complete \\',
    '  -H "CRA_HEADER" -H "Content-Type: application/json" \\',
    '  -d "{\\"session_id\\":\\"SESSION_PLACEHOLDER\\",\\"task_id\\":TASK_PLACEHOLDER,\\"status\\":\\"done\\",\\"result\\":\\"resolved\\"}"',
    '',
    'Bei Fehler:',
    'curl -s -X POST CRA_PLACEHOLDER/api/cra/worker/complete \\',
    '  -H "CRA_HEADER" -H "Content-Type: application/json" \\',
    '  -d "{\\"session_id\\":\\"SESSION_PLACEHOLDER\\",\\"task_id\\":TASK_PLACEHOLDER,\\"status\\":\\"failed\\",\\"result\\":\\"failed\\",\\"error\\":\\"Beschreibung...\\"}"',
    '',
    '=== WICHTIG ===',
    '- NUR staging-Branch, NIEMALS main/master',
    '- CRA-Analyse ist PFLICHT vor jedem Commit',
    '- Bei BLOCKED: anpassen, nicht ignorieren',
    '- Maximal 3 Review-Iterationen, dann eskalieren',
    '- Heartbeat alle 5 Minuten senden'
  ].join('\n');
}

function workerComplete(sessionId, taskId, status, result, errorMsg) {
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  var taskStatus = (status === 'done') ? 'done' : 'failed';
  var sessionResult = (status === 'done') ? (result || 'resolved') : (result || 'failed');

  // Task-Update in Transaktion (Session-Complete hat eigene DB-Writes)
  craDb.transaction(function() {
    craDb.run(
      "UPDATE claude_tasks SET status = ?, completed_at = ? WHERE id = ?",
      [taskStatus, now, taskId]
    );
  });

  // Session abschliessen (nutzt bestehende completeSession mit Gates)
  var sessionRes = completeSession(sessionId, sessionResult, errorMsg || null);

  console.log('[CRA/Worker] Complete:', sessionId, 'Task#' + taskId, '→', taskStatus);
  return { ok: true, session: sessionRes, task_status: taskStatus };
}

// -- Cleanup: Stuck Sessions + Tasks bereinigen (vom Worker aufgerufen) --

function runCleanup() {
  var cleaned = { sessions: 0, tasks: 0 };

  // 1. Expired Sessions (running + queued ohne Heartbeat seit 20 Min)
  checkExpiredSessions();

  // 2. Stuck Tasks: picked seit > 30 Min -> failed
  var taskCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
  var stuckTasks = craDb.all(
    "SELECT * FROM claude_tasks WHERE status = 'picked' AND created_at < ?",
    [taskCutoff]
  );
  stuckTasks.forEach(function(t) {
    craDb.run("UPDATE claude_tasks SET status = 'failed' WHERE id = ?", [t.id]);
    cleaned.tasks++;
    console.log('[CRA/Cleanup] Stuck Task bereinigt:', t.id, t.finding_id);
  });

  if (cleaned.tasks > 0) craDb.saveCraDb();
  return cleaned;
}

module.exports = {
  start: start,
  stop: stop,
  getStatus: getStatus,
  dispatchNext: dispatchNext,
  heartbeat: heartbeat,
  completeSession: completeSession,
  getActiveSession: getActiveSession,
  getSessions: getSessions,
  generateDailySummary: generateDailySummary,
  getNextFinding: getNextFinding,
  getStagingVerifiedFindings: getStagingVerifiedFindings,
  canDeployProd: canDeployProd,
  checkGates: checkGates,
  runCleanup: runCleanup,
  pickTask: pickTask,
  workerComplete: workerComplete
};
