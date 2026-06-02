// SPDX-License-Identifier: Apache-2.0
// admin/cra/watchdog-api.js — Schicht B Live-Watchdog (Vorbereitung 2026-04-30)
//
// Endpoints:
//   POST /api/cra/watchdog/check    Token-Auth, von Cron alle 60s
//   GET  /api/cra/watchdog/status   public, fuer Landing-Status-Badge (Punkt 3)
//   GET  /api/cra/watchdog/history  Token-Auth, letzte Restart-Events
//
// Verhalten:
//   - Iteriert Tabelle apps (existiert) WHERE watchdog_enabled=1
//   - Maintenance-Mode aus ops_app_context respektieren
//   - Health-Probe http://127.0.0.1:<port>/health (bzw. apps.health_path falls gesetzt)
//   - Hysterese: 2 Failures hintereinander -> Restart-Trigger
//   - Crash-Loop-Schutz: max 3 Restarts pro App in 10min -> STOP + Push
//   - Restart via spawnSync('sudo', ['-u', user, 'pm2', 'restart', name]) — sudoers-whitelist Pflicht
//   - Audit: hook_events + OpsDesk-Ticket P2

var craDb = require('./cra-db');
// opsdesk-db ist optional (nur CRA Plus, via MERIDIAN_OPSDESK_DIR). Im OSS-Core
// bleibt opDb null; die Nutzung (isMaintenanceMode) ist per try/catch geguarded.
var opDb = null;
if (process.env.MERIDIAN_OPSDESK_DIR) {
  try { opDb = require(require('path').join(process.env.MERIDIAN_OPSDESK_DIR, 'opsdesk-db')); } catch (e) { /* opsdesk optional */ }
}
var spawnSync = require('child_process').spawnSync;
var http = require('http');

var FAILURE_THRESHOLD = 2;
var RESTART_WINDOW_MS = 10 * 60 * 1000;
var MAX_RESTARTS_IN_WINDOW = 3;
var HEALTH_TIMEOUT_MS = 5000;

// In-memory state pro App: { failures, lastRestarts: [ts1, ts2, ...] }
var watchdogState = {};

function requireToken(req, res) {
  if (req.headers['x-cra-token'] !== process.env.CRA_API_TOKEN) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  return true;
}

function isMaintenanceMode(appKey) {
  try {
    var row = opDb.get(
      "SELECT context_value FROM ops_app_context WHERE app=? AND context_key='maintenance_mode'",
      [appKey]
    );
    return row && (row.context_value === '1' || row.context_value === 'true');
  } catch (e) { return false; }
}

function probe(port, healthPath, callback) {
  var path = healthPath || '/health';
  var req = http.get({ host: '127.0.0.1', port: port, path: path, timeout: HEALTH_TIMEOUT_MS }, function(res) {
    var ok = res.statusCode >= 200 && res.statusCode < 500;
    res.resume();
    callback(ok, res.statusCode);
  });
  req.on('error', function() { callback(false, 0); });
  req.on('timeout', function() { req.destroy(); callback(false, 0); });
}

function probeAsync(port, healthPath) {
  return new Promise(function(resolve) { probe(port, healthPath, function(ok, code) { resolve({ ok: ok, code: code }); }); });
}

function recordHookEvent(appName, eventType, details) {
  try {
    craDb.run(
      'INSERT INTO hook_events (hook_name, event_type, repo_name, details) VALUES (?,?,?,?)',
      ['cra-watchdog', eventType, appName, details]
    );
    craDb.saveCraDb();
  } catch (e) { /* ignore */ }
}

function attemptRestart(app) {
  // sudoers-whitelist (Beispiel /etc/sudoers.d/cra-watchdog):
  //   root ALL=(<user>) NOPASSWD: /usr/bin/pm2 restart <pm2_name>
  var r = spawnSync('sudo', ['-u', app.user, 'pm2', 'restart', app.pm2_name], { timeout: 30000 });
  return r.status === 0;
}

function notifyCrashLoop(appName, recentRestarts) {
  // 1) hook_events
  recordHookEvent(appName, 'crash-loop-stop', 'restarts=' + recentRestarts + ' window=10min');
  // 2) OpsDesk-Ticket P2
  try {
    var opsdeskApi = process.env.MERIDIAN_OPSDESK_DIR ? require(require('path').join(process.env.MERIDIAN_OPSDESK_DIR, 'opsdesk-api')) : null;
    if (opsdeskApi && opsdeskApi.createTicketInternal) {
      opsdeskApi.createTicketInternal({
        app: appName, priority: 'P2', title: 'Watchdog Crash-Loop ' + appName,
        body: 'CRA-Watchdog hat ' + recentRestarts + ' Restarts in 10 Minuten erkannt und STOP ausgeloest. Manueller Eingriff noetig.',
        source: 'cra-watchdog'
      });
    }
  } catch (e) { /* opsdesk optional */ }
  // 3) Push (falls ntfy/Pushover konfiguriert)
  // TODO: PUSH_NOTIFY_URL Env-Hook fuer ntfy.sh Topic
}

async function checkAll(req, res) {
  if (!requireToken(req, res)) return;

  var apps;
  try {
    apps = craDb.all(
      "SELECT app_key, app_name, port, user, pm2_name, health_path FROM apps " +
      "WHERE watchdog_enabled=1"
    );
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'apps-table missing watchdog_enabled column — run migration first' }));
    return;
  }

  var now = Date.now();
  var report = [];

  for (var i = 0; i < apps.length; i++) {
    var app = apps[i];
    var key = app.app_key;
    var state = watchdogState[key] || (watchdogState[key] = { failures: 0, lastRestarts: [] });

    if (isMaintenanceMode(key)) {
      report.push({ app: key, status: 'maintenance' });
      state.failures = 0;
      continue;
    }

    var probe = await probeAsync(app.port, app.health_path);

    if (probe.ok) {
      state.failures = 0;
      report.push({ app: key, status: 'ok', code: probe.code });
      continue;
    }

    state.failures++;
    if (state.failures < FAILURE_THRESHOLD) {
      report.push({ app: key, status: 'pending', failures: state.failures });
      continue;
    }

    // Crash-Loop check
    state.lastRestarts = state.lastRestarts.filter(function(t) { return now - t < RESTART_WINDOW_MS; });
    if (state.lastRestarts.length >= MAX_RESTARTS_IN_WINDOW) {
      notifyCrashLoop(app.app_name, state.lastRestarts.length);
      report.push({ app: key, status: 'crash-loop-stop' });
      continue;
    }

    var restarted = attemptRestart(app);
    state.lastRestarts.push(now);
    state.failures = 0;
    recordHookEvent(app.app_name, restarted ? 'auto-restart' : 'auto-restart-failed',
      'after-failures=' + FAILURE_THRESHOLD + ' restarts-in-window=' + state.lastRestarts.length);
    report.push({ app: key, status: restarted ? 'restarted' : 'restart-failed' });
  }

  res.end(JSON.stringify({ ok: true, checked: apps.length, report: report }));
}

// Public Status fuer Landing-Badge (Punkt 3)
function publicStatus(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=30');

  var apps;
  try {
    apps = craDb.all(
      "SELECT app_key, app_name FROM apps WHERE public_status=1 AND watchdog_enabled=1"
    );
  } catch (e) {
    res.end(JSON.stringify({ overall: 'unknown' }));
    return;
  }

  var statuses = apps.map(function(app) {
    var s = watchdogState[app.app_key];
    var status = 'ok';
    if (isMaintenanceMode(app.app_key)) status = 'maintenance';
    else if (s && s.failures >= FAILURE_THRESHOLD) status = 'down';
    else if (s && s.failures > 0) status = 'degraded';
    return { app: app.app_key, name: app.app_name, status: status };
  });

  var overall = 'ok';
  if (statuses.some(function(s) { return s.status === 'down'; })) overall = 'down';
  else if (statuses.some(function(s) { return s.status === 'degraded'; })) overall = 'degraded';
  else if (statuses.every(function(s) { return s.status === 'maintenance'; })) overall = 'maintenance';

  res.end(JSON.stringify({ overall: overall, apps: statuses, ts: new Date().toISOString() }));
}

function history(req, res) {
  if (!requireToken(req, res)) return;
  var rows = craDb.all(
    "SELECT created_at, repo_name AS app, event_type, details " +
    "FROM hook_events WHERE hook_name='cra-watchdog' " +
    "ORDER BY created_at DESC LIMIT 100"
  );
  res.end(JSON.stringify({ events: rows }));
}

// DB-Migration helper
function ensureWatchdogColumns() {
  // Defensive: existing apps-table erweitern, ohne Daten zu verlieren
  try { craDb.run("ALTER TABLE apps ADD COLUMN watchdog_enabled INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { craDb.run("ALTER TABLE apps ADD COLUMN public_status INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { craDb.run("ALTER TABLE apps ADD COLUMN health_path TEXT"); } catch (e) {}
  try { craDb.run("ALTER TABLE apps ADD COLUMN pm2_name TEXT"); } catch (e) {}
  try { craDb.run("ALTER TABLE apps ADD COLUMN port INTEGER"); } catch (e) {}
  try { craDb.run("ALTER TABLE apps ADD COLUMN user TEXT"); } catch (e) {}
  craDb.saveCraDb();
}

module.exports = {
  checkAll: checkAll,
  publicStatus: publicStatus,
  history: history,
  ensureWatchdogColumns: ensureWatchdogColumns
};
