// SPDX-License-Identifier: Apache-2.0
// admin/cra/cra-nightworker.js — Autonomer Nacht-Worker (CommonJS)
// PM2 Service: Scannt, plant, fixt Findings auf Staging. Nur nachts aktiv.
var child = require('child_process');
var fs = require('fs');
var path = require('path');
var craDb = require('./cra-db');
var craRules = require('./cra-rules');
var scanner = require('./cra-scanner');
var patcher = require('./cra-patcher');
var analyzer = require('./cra-analyzer');

// ── Konfiguration ───────────────────────────────────────────────────

var WINDOW_START_HOUR = 23;  // 23:30 CET
var WINDOW_START_MIN = 30;
var WINDOW_END_HOUR = 4;     // 04:30 CET
var WINDOW_END_MIN = 30;
var MAX_ATTEMPTS = 3;         // Pro Finding
var FIX_TIMEOUT_MS = 15 * 60 * 1000;  // 15 Min pro Finding
var HEALTH_TIMEOUT_MS = 30000;         // 30s Health-Check
var TEST_TIMEOUT_MS = 5 * 60 * 1000;   // 5 Min Test-Suite
var CHECK_INTERVAL_MS = 5 * 60 * 1000; // Alle 5 Min prüfen ob Fenster offen

var state = {
  running: false,
  currentFinding: null,
  currentApp: null,
  nightReport: null,
  lastNight: null,
  timer: null
};

// ── DB-Schema für Nacht-Reports ─────────────────────────────────────

function initDb() {
  try {
    craDb.run("CREATE TABLE IF NOT EXISTS nw_runs (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT," +
      "started_at TEXT," +
      "ended_at TEXT," +
      "findings_attempted INTEGER DEFAULT 0," +
      "findings_fixed INTEGER DEFAULT 0," +
      "findings_failed INTEGER DEFAULT 0," +
      "findings_skipped INTEGER DEFAULT 0," +
      "details_json TEXT," +
      "status TEXT DEFAULT 'running'" +
    ")");
    craDb.run("CREATE TABLE IF NOT EXISTS nw_fix_log (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT," +
      "run_id INTEGER," +
      "finding_id TEXT," +
      "app TEXT," +
      "attempt INTEGER DEFAULT 1," +
      "status TEXT," +
      "patch_json TEXT," +
      "review_result TEXT," +
      "test_result TEXT," +
      "error TEXT," +
      "created_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")");
    craDb.saveCraDb();
  } catch(e) {
    console.error('[NW] DB-Init Fehler:', e.message);
  }
}

// ── Zeitprüfung: Sind wir im Nacht-Fenster? ────────────────────────

function inWindow() {
  var now = new Date();
  // CET/CEST
  var cet = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  var h = cet.getHours();
  var m = cet.getMinutes();
  var total = h * 60 + m;
  var start = WINDOW_START_HOUR * 60 + WINDOW_START_MIN;  // 23:30 = 1410
  var end = WINDOW_END_HOUR * 60 + WINDOW_END_MIN;        // 04:30 = 270
  // Nacht-Fenster: start > end (über Mitternacht)
  return total >= start || total < end;
}

function cetNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).replace('T', ' ').substring(0, 19);
}

// ── Pre-Flight Checks ───────────────────────────────────────────────

function preFlight() {
  var errors = [];

  // Disk
  try {
    var diskOut = child.execSync("df -BG / | tail -1 | awk '{print $4}'", { encoding: 'utf8', timeout: 5000 });
    var freeGb = parseInt(diskOut) || 0;
    if (freeGb < 1) errors.push('Disk: nur ' + freeGb + 'GB frei (min 1GB)');
  } catch(e) { errors.push('Disk-Check fehlgeschlagen'); }

  // RAM
  try {
    var ramOut = child.execSync("free -m | awk 'NR==2{print $7}'", { encoding: 'utf8', timeout: 5000 });
    var freeMb = parseInt(ramOut) || 0;
    if (freeMb < 500) errors.push('RAM: nur ' + freeMb + 'MB frei (min 500MB)');
  } catch(e) { errors.push('RAM-Check fehlgeschlagen'); }

  return errors;
}

// ── Startup-Recovery: Aufräumen nach Crash ──────────────────────────

function startupRecovery() {
  var rules = craRules.loadRules();
  var apps = (rules && rules.apps) || [];

  apps.forEach(function(app) {
    if (!app.staging_user || !app.staging_pm2) return;

    // Staging-App die noch läuft → stoppen
    try {
      var status = child.execSync(
        "su - " + app.staging_user + " -c 'pm2 jlist 2>/dev/null'",
        { encoding: 'utf8', timeout: 10000 }
      );
      var procs = JSON.parse(status);
      procs.forEach(function(p) {
        if (p.pm2_env && p.pm2_env.status === 'online') {
          console.log('[NW] Recovery: Stoppe laufende Staging-App', app.id, p.name);
          child.execSync("su - " + app.staging_user + " -c 'pm2 stop all'", { timeout: 10000 });
        }
      });
    } catch(e) { /* App hat kein PM2 oder User existiert nicht */ }

    // Uncommitted Changes auf Staging → reset
    if (app.staging_dir && fs.existsSync(app.staging_dir)) {
      try {
        var gitStatus = child.execSync('git -C ' + JSON.stringify(app.staging_dir) + ' status --porcelain', { encoding: 'utf8', timeout: 5000 });
        if (gitStatus && gitStatus.trim()) {
          console.log('[NW] Recovery: Reset uncommitted changes in', app.id);
          child.execSync('git -C ' + JSON.stringify(app.staging_dir) + ' checkout -- .', { timeout: 10000 });
        }
      } catch(e) { /* ignore */ }
    }
  });
}

// ── Netzwerk-Sandbox (iptables) ─────────────────────────────────────
// Retro CRITICAL #4: user-String ging bisher via execSync (Shell-Interpret).
// Jetzt: Unix-Username Whitelist + spawnSync mit Array-Args (kein Shell).
var USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

function validateUser(user) {
  if (typeof user !== 'string' || !USER_PATTERN.test(user)) {
    throw new Error('Invalid unix username: ' + JSON.stringify(user));
  }
  return user;
}

function runIptables(args) {
  // execFile statt execSync — keine Shell, Args als Array
  var r = child.spawnSync('iptables', args, { timeout: 5000, encoding: 'utf8' });
  if (r.status !== 0 && r.stderr && r.stderr.indexOf('does a matching rule exist') === -1) {
    throw new Error('iptables ' + args.join(' ') + ' failed: ' + r.stderr);
  }
}

function sandboxOn(user) {
  try {
    validateUser(user);
    // Nur localhost + eigener Server erlaubt, alles andere blocked
    runIptables(['-A', 'OUTPUT', '-m', 'owner', '--uid-owner', user, '-d', '127.0.0.0/8', '-j', 'ACCEPT']);
    runIptables(['-A', 'OUTPUT', '-m', 'owner', '--uid-owner', user, '-d', (process.env.MERIDIAN_SERVER_HOST || 'localhost'), '-j', 'ACCEPT']);
    runIptables(['-A', 'OUTPUT', '-m', 'owner', '--uid-owner', user, '-j', 'DROP']);
    console.log('[NW] Sandbox ON fuer', user);
  } catch(e) {
    console.error('[NW] Sandbox-Fehler:', e.message);
  }
}

function sandboxOff(user) {
  try {
    validateUser(user);
    // Regeln entfernen (in umgekehrter Reihenfolge). -D kann fehlschlagen wenn Regel nicht existiert — OK.
    try { runIptables(['-D', 'OUTPUT', '-m', 'owner', '--uid-owner', user, '-j', 'DROP']); } catch(e) {}
    try { runIptables(['-D', 'OUTPUT', '-m', 'owner', '--uid-owner', user, '-d', (process.env.MERIDIAN_SERVER_HOST || 'localhost'), '-j', 'ACCEPT']); } catch(e) {}
    try { runIptables(['-D', 'OUTPUT', '-m', 'owner', '--uid-owner', user, '-d', '127.0.0.0/8', '-j', 'ACCEPT']); } catch(e) {}
    console.log('[NW] Sandbox OFF fuer', user);
  } catch(e) { /* ignore */ }
}

// ── DB-Snapshot ─────────────────────────────────────────────────────

function dbSnapshot(app) {
  // SQLite-DBs sichern (falls vorhanden)
  var dbDir = '/var/lib/' + app.id;
  if (!fs.existsSync(dbDir)) return null;
  var snapshotDir = '/tmp/nw-snapshot-' + app.id + '-' + Date.now();
  try {
    child.execSync('cp -r ' + JSON.stringify(dbDir) + ' ' + JSON.stringify(snapshotDir), { timeout: 15000 });
    console.log('[NW] DB-Snapshot:', snapshotDir);
    return snapshotDir;
  } catch(e) {
    console.error('[NW] Snapshot-Fehler:', e.message);
    return null;
  }
}

function dbRestore(app, snapshotDir) {
  if (!snapshotDir || !fs.existsSync(snapshotDir)) return;
  var dbDir = '/var/lib/' + app.id;
  try {
    child.execSync('rm -rf ' + JSON.stringify(dbDir) + ' && cp -r ' + JSON.stringify(snapshotDir) + ' ' + JSON.stringify(dbDir), { timeout: 15000 });
    console.log('[NW] DB-Restore:', snapshotDir, '→', dbDir);
  } catch(e) {
    console.error('[NW] Restore-Fehler:', e.message);
  }
}

// ── Staging-App Start/Stop ──────────────────────────────────────────

function stagingStart(app) {
  try {
    child.execSync("su - " + app.staging_user + " -c 'pm2 start " + app.staging_pm2 + " 2>/dev/null || pm2 restart " + app.staging_pm2 + "'", { timeout: 15000 });
    // Warten bis App hochgefahren ist (Node.js braucht 3-8s)
    child.execSync('sleep 8', { timeout: 15000 });
    console.log('[NW] Staging START:', app.id);
    return true;
  } catch(e) {
    console.error('[NW] Start-Fehler:', app.id, e.message);
    return false;
  }
}

function stagingStop(app) {
  try {
    child.execSync("su - " + app.staging_user + " -c 'pm2 stop all'", { timeout: 15000 });
    console.log('[NW] Staging STOP:', app.id);
  } catch(e) {
    console.error('[NW] Stop-Fehler:', app.id, e.message);
  }
}

function healthCheck(app) {
  // Retry: 3 Versuche mit 3s Abstand (App braucht manchmal laenger)
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var url = 'http://localhost:' + app.staging_port + '/';
      var result = child.execSync(
        'curl -s -o /dev/null -w "%{http_code}" --max-time 10 ' + url,
        { encoding: 'utf8', timeout: HEALTH_TIMEOUT_MS }
      );
      var code = parseInt(result) || 0;
      if (code >= 200 && code < 500) return true;
    } catch(e) {}
    if (attempt < 2) {
      try { child.execSync('sleep 3', { timeout: 5000 }); } catch(e) {}
    }
  }
  return false;
}

// ── Git-Operationen ─────────────────────────────────────────────────

function gitPrepare(app) {
  var dir = app.staging_dir;
  try {
    child.execSync('git -C ' + JSON.stringify(dir) + ' fetch origin', { timeout: 15000 });
    // Staging-Branch: main oder staging
    var branches = child.execSync('git -C ' + JSON.stringify(dir) + ' branch -r', { encoding: 'utf8', timeout: 5000 });
    var targetBranch = branches.indexOf('origin/staging') >= 0 ? 'staging' : 'main';
    child.execSync('git -C ' + JSON.stringify(dir) + ' checkout ' + targetBranch + ' 2>/dev/null || git -C ' + JSON.stringify(dir) + ' checkout -b ' + targetBranch + ' origin/' + targetBranch, { timeout: 10000 });
    child.execSync('git -C ' + JSON.stringify(dir) + ' reset --hard origin/' + targetBranch, { timeout: 10000 });
    // Ownership
    child.execSync('chown -R ' + app.staging_user + ':' + app.staging_user + ' ' + JSON.stringify(dir), { timeout: 15000 });
    return targetBranch;
  } catch(e) {
    console.error('[NW] Git-Prepare Fehler:', app.id, e.message);
    return null;
  }
}

function gitCommitAndPush(app, finding, branch) {
  var dir = app.staging_dir;
  try {
    child.execSync('git -C ' + JSON.stringify(dir) + ' add -A', { timeout: 5000 });
    var msg = 'fix(nightworker): ' + finding.id + ' — ' + (finding.title || '').substring(0, 60);
    child.execSync('git -C ' + JSON.stringify(dir) + " commit -m " + JSON.stringify(msg), { timeout: 10000 });
    child.execSync('git -C ' + JSON.stringify(dir) + ' push origin ' + branch + ' --force-with-lease', { timeout: 15000 });
    console.log('[NW] Committed + pushed:', finding.id);
    return true;
  } catch(e) {
    console.error('[NW] Git-Commit Fehler:', e.message);
    return false;
  }
}

function gitRevert(app, branch) {
  var dir = app.staging_dir;
  try {
    child.execSync('git -C ' + JSON.stringify(dir) + ' reset --hard origin/' + branch, { timeout: 10000 });
    child.execSync('chown -R ' + app.staging_user + ':' + app.staging_user + ' ' + JSON.stringify(dir), { timeout: 15000 });
    console.log('[NW] Git revert:', app.id);
  } catch(e) {
    console.error('[NW] Revert-Fehler:', e.message);
  }
}

// ── Test-Suite ausführen ────────────────────────────────────────────

function runTests(app) {
  // Health-Check ist Pflicht
  if (!healthCheck(app)) return { pass: false, error: 'Health-Check fehlgeschlagen' };

  // App-spezifische Test-Suite (falls vorhanden)
  var testScripts = {
    'team': 'bash /opt/ks-management/team-test.sh staging',
    'motokompass': 'bash /opt/ks-management/motokompass-test.sh staging',
    'hvw': 'bash /opt/ks-management/tests/hvw-test.sh staging',
  };

  if (testScripts[app.id]) {
    try {
      var output = child.execSync(testScripts[app.id], { encoding: 'utf8', timeout: TEST_TIMEOUT_MS });
      console.log('[NW] Tests OK:', app.id);
      return { pass: true, output: output.substring(0, 500) };
    } catch(e) {
      return { pass: false, error: 'Tests fehlgeschlagen: ' + (e.stderr || e.message || '').substring(0, 300) };
    }
  }

  // Kein Test-Script → nur Health-Check
  return { pass: true, output: 'Nur Health-Check (keine Test-Suite fuer ' + app.id + ')' };
}

// ── Einen Finding fixen (ein Versuch) ───────────────────────────────

function fixFinding(finding, app, branch, runId, attempt, callback) {
  state.currentFinding = finding.id;
  console.log('[NW] Fix-Versuch', attempt, 'fuer', finding.id, '(' + finding.severity + ')');

  // 1. Patch generieren
  patcher.generatePatch(finding, app.staging_dir, function(err, patch) {
    if (err || !patch || !patch.changes || !patch.changes.length) {
      logFix(runId, finding, app, attempt, 'patch_failed', null, null, null, patch ? patch.error : 'Kein Patch');
      return callback('patch_failed');
    }

    // 2. Patch anwenden
    var applyResult = patcher.applyPatch(app.staging_dir, patch);
    if (!applyResult.applied.length) {
      logFix(runId, finding, app, attempt, 'apply_failed', patch, null, null, applyResult.failed.map(function(f) { return f.file + ': ' + f.error; }).join(', '));
      return callback('apply_failed');
    }

    // 3. Syntax-Check
    var syntaxErrors = patcher.syntaxCheck(app.staging_dir, applyResult.applied);
    if (syntaxErrors.length) {
      gitRevert(app, branch);
      logFix(runId, finding, app, attempt, 'syntax_error', patch, null, null, syntaxErrors.map(function(e) { return e.file + ': ' + e.error; }).join(', '));
      return callback('syntax_error');
    }

    // 4. CRA Self-Review (statische Checks)
    var diff = '';
    try {
      diff = child.execSync('git -C ' + JSON.stringify(app.staging_dir) + ' diff', { encoding: 'utf8', timeout: 10000 });
    } catch(e) { diff = ''; }

    if (diff) {
      var rules = craRules.loadRules();
      var craResult = analyzer.analyzeDiff ? require('./cra-analyzer').analyzeDiff(diff, rules) : null;
      if (craResult && craResult.riskScore >= 20) {
        gitRevert(app, branch);
        logFix(runId, finding, app, attempt, 'cra_blocked', patch, 'BLOCKED (Score ' + craResult.riskScore + ')', null, craResult.findings.map(function(f) { return f.message; }).join(', '));
        return callback('cra_blocked');
      }
    }

    // 5. Cross-Model-Review
    patcher.crossReview(finding, patch, function(err2, review) {
      if (review && review.verdict === 'reject') {
        gitRevert(app, branch);
        logFix(runId, finding, app, attempt, 'review_rejected', patch, review.reason, null, null);
        return callback('review_rejected');
      }

      // 6. Commit + Push
      var committed = gitCommitAndPush(app, finding, branch);
      if (!committed) {
        gitRevert(app, branch);
        logFix(runId, finding, app, attempt, 'commit_failed', patch, null, null, 'git commit/push failed');
        return callback('commit_failed');
      }

      // 7. Validierung (KEIN Staging-Restart — Prod laeuft, Staging ist gestoppt)
      // Syntax-Check + CRA-Review waren schon in Schritt 3+4.
      // Prod-App wird NICHT angefasst — Morning-Gate entscheidet ueber Deploy.
      console.log('[NW] Patch committed + pushed. Morning-Gate entscheidet ueber Prod-Deploy.');
      logFix(runId, finding, app, attempt, 'fixed', patch, review ? review.verdict : 'approve', 'Committed to ' + branch + ', Prod-Deploy via Morning-Gate', null);
      callback(null); // success
    });
  });
}

function logFix(runId, finding, app, attempt, status, patch, reviewResult, testResult, error) {
  try {
    craDb.run(
      'INSERT INTO nw_fix_log (run_id, finding_id, app, attempt, status, patch_json, review_result, test_result, error) VALUES (?,?,?,?,?,?,?,?,?)',
      [runId, finding.id, app.id, attempt, status,
       patch ? JSON.stringify({ changes: patch.changes.map(function(c) { return { file: c.file }; }), explanation: patch.explanation }) : null,
       reviewResult || null, testResult || null, error || null]
    );
    craDb.saveCraDb();
  } catch(e) { console.error('[NW] Log-Fehler:', e.message); }
}

// ── Nacht-Durchlauf ─────────────────────────────────────────────────

function nightRun(opts) {
  opts = opts || {};
  var force = opts.force || false;
  if (state.running) { console.log('[NW] Bereits aktiv'); return; }
  state.running = true;
  state.forceMode = force;

  console.log('[NW] ═══ NACHT-FENSTER GEÖFFNET ═══', cetNow());

  // Pre-Flight
  var pfErrors = preFlight();
  if (pfErrors.length) {
    console.error('[NW] Pre-Flight FAILED:', pfErrors.join(', '));
    state.running = false;
    return;
  }

  // Startup-Recovery
  startupRecovery();

  // Scan
  initDb();
  scanner.fullScan();

  // Findings laden + nach App gruppieren
  var findings = scanner.getOpenFindings();
  if (!findings.length) {
    console.log('[NW] Keine offenen Findings. Nacht-Fenster geschlossen.');
    state.running = false;
    return;
  }

  // Run in DB anlegen
  craDb.run("INSERT INTO nw_runs (started_at, status) VALUES (?, 'running')", [cetNow()]);
  craDb.saveCraDb();
  var runId = craDb.get('SELECT last_insert_rowid() as id').id;

  var rules = craRules.loadRules();
  var apps = (rules && rules.apps) || [];
  var appMap = {};
  apps.forEach(function(a) { appMap[a.id] = a; });

  // Pro App gruppieren
  var appGroups = {};
  findings.forEach(function(f) {
    var appId = null;
    try { appId = JSON.parse(f.apps_json || '[]')[0]; } catch(e) {}
    if (!appId || !appMap[appId]) return;
    if (!appGroups[appId]) appGroups[appId] = [];
    appGroups[appId].push(f);
  });

  var appIds = Object.keys(appGroups);
  var stats = { attempted: 0, fixed: 0, failed: 0, skipped: 0 };

  // Sequentiell pro App abarbeiten
  function processApp(idx) {
    if (idx >= appIds.length || (!state.forceMode && !inWindow())) {
      return finishNight(runId, stats);
    }

    var appId = appIds[idx];
    var app = appMap[appId];
    var appFindings = appGroups[appId];

    if (!app.staging_dir || !app.staging_user || !app.staging_pm2) {
      console.log('[NW] Skip:', appId, '(keine Staging-Config)');
      stats.skipped += appFindings.length;
      return processApp(idx + 1);
    }

    console.log('[NW] ── App:', appId, '(' + appFindings.length + ' Findings) ──');

    // Git vorbereiten
    var branch = gitPrepare(app);
    if (!branch) {
      stats.skipped += appFindings.length;
      return processApp(idx + 1);
    }

    // DB-Snapshot
    var snapshot = dbSnapshot(app);

    // Health-Check gegen Prod. Staging-only Apps (port=null) haben kein Prod —
    // fixFinding() startet die Staging-App selbst; wir überspringen den Pre-Health-Check
    // und verlassen uns auf den Test-Lauf danach.
    if (app.port) {
      var healthOk = false;
      try {
        var hUrl = 'http://localhost:' + app.port + '/';
        var hResult = child.execSync(
          'curl -s -o /dev/null -w "%{http_code}" --max-time 10 ' + hUrl,
          { encoding: 'utf8', timeout: HEALTH_TIMEOUT_MS }
        );
        healthOk = (parseInt(hResult) || 0) >= 200 && (parseInt(hResult) || 0) < 500;
      } catch(e) {}

      if (!healthOk) {
        console.error('[NW] Prod-Health-Check fehlgeschlagen fuer', appId, '(Port ' + app.port + ')');
        stats.skipped += appFindings.length;
        return processApp(idx + 1);
      }
    } else {
      console.log('[NW] Staging-only App', appId, '— Pre-Health-Check übersprungen');
    }

    // Findings sequentiell abarbeiten (Code im Staging-Dir, Tests gegen Prod)
    (function() {
      function processFinding(fIdx) {
        if (fIdx >= appFindings.length || (!state.forceMode && !inWindow())) {
          return processApp(idx + 1);
        }

        var finding = appFindings[fIdx];
        stats.attempted++;

        // Max Attempts
        var prevAttempts = craDb.get(
          "SELECT COUNT(*) as c FROM nw_fix_log WHERE finding_id = ? AND status != 'fixed'", [finding.id]
        );
        if (prevAttempts && prevAttempts.c >= MAX_ATTEMPTS) {
          console.log('[NW] Max Attempts erreicht, eskaliere:', finding.id);
          craDb.run("UPDATE findings SET status = 'escalated', updated_at = datetime('now','localtime') WHERE id = ?", [finding.id]);
          craDb.saveCraDb();
          stats.failed++;
          return processFinding(fIdx + 1);
        }

        var attempt = (prevAttempts ? prevAttempts.c : 0) + 1;

        fixFinding(finding, app, branch, runId, attempt, function(err) {
          if (!err) {
            // Erfolg
            craDb.run("UPDATE findings SET status = 'staged', updated_at = datetime('now','localtime') WHERE id = ?", [finding.id]);
            craDb.saveCraDb();
            stats.fixed++;
          } else {
            stats.failed++;
            // Bei Test-Fehler: DB-Restore
            if (err === 'test_failed' && snapshot) {
              dbRestore(app, snapshot);
            }
          }
          processFinding(fIdx + 1);
        });
      }

      processFinding(0);
    })();
  }

  processApp(0);
}

function finishNight(runId, stats) {
  console.log('[NW] ═══ NACHT ABGESCHLOSSEN ═══');
  console.log('[NW] Attempted:', stats.attempted, '| Fixed:', stats.fixed, '| Failed:', stats.failed, '| Skipped:', stats.skipped);

  try {
    craDb.run(
      "UPDATE nw_runs SET ended_at = ?, findings_attempted = ?, findings_fixed = ?, findings_failed = ?, findings_skipped = ?, status = 'completed', details_json = ? WHERE id = ?",
      [cetNow(), stats.attempted, stats.fixed, stats.failed, stats.skipped, JSON.stringify(stats), runId]
    );
    craDb.saveCraDb();
  } catch(e) { console.error('[NW] Finish-Fehler:', e.message); }

  state.nightReport = stats;
  state.lastNight = cetNow();
  state.running = false;
  state.currentFinding = null;
  state.currentApp = null;

  // Cleanup: /tmp Snapshots entfernen
  try {
    child.execSync('rm -rf /tmp/nw-snapshot-* 2>/dev/null', { timeout: 5000 });
  } catch(e) { /* ignore */ }
}

// ── Timer-Loop ──────────────────────────────────────────────────────

function start() {
  initDb();
  console.log('[NW] Nightworker gestartet (Fenster: ' + WINDOW_START_HOUR + ':' + WINDOW_START_MIN + ' - ' + WINDOW_END_HOUR + ':' + WINDOW_END_MIN + ' CET)');

  // Startup-Recovery
  startupRecovery();

  // Sofort prüfen
  if (inWindow() && !state.running) {
    nightRun();
  }

  // Alle 5 Min prüfen
  state.timer = setInterval(function() {
    if (inWindow() && !state.running) {
      // Nur einmal pro Nacht
      var today = new Date().toISOString().substring(0, 10);
      if (state.lastNight && state.lastNight.substring(0, 10) === today) return;
      nightRun();
    }
  }, CHECK_INTERVAL_MS);
}

function stop() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.running = false;
  console.log('[NW] Nightworker gestoppt');
}

function getStatus() {
  return {
    running: state.running,
    currentFinding: state.currentFinding,
    currentApp: state.currentApp,
    lastNight: state.lastNight,
    nightReport: state.nightReport,
    inWindow: inWindow(),
    windowHours: WINDOW_START_HOUR + ':' + WINDOW_START_MIN + ' - ' + WINDOW_END_HOUR + ':' + WINDOW_END_MIN + ' CET'
  };
}

function getLastRun() {
  return craDb.get("SELECT * FROM nw_runs ORDER BY id DESC LIMIT 1");
}

function getFixLog(runId) {
  return craDb.all("SELECT * FROM nw_fix_log WHERE run_id = ? ORDER BY id ASC", [runId]) || [];
}

module.exports = {
  start: start,
  stop: stop,
  getStatus: getStatus,
  getLastRun: getLastRun,
  getFixLog: getFixLog,
  nightRun: nightRun,  // Manueller Trigger für Tests
  inWindow: inWindow,
  initDb: initDb
};
