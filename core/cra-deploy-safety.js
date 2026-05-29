// admin/cra/cra-deploy-safety.js — Deploy-Sicherheit (CommonJS)
// Pre-Deploy Backup, Post-Deploy Health, Auto-Rollback, Circuit Breaker
var child = require('child_process');
var fs = require('fs');
var path = require('path');
var https = require('https');
var http = require('http');
var craDb = require('./cra-db');

var HEALTH_CHECK_RETRIES = 3;
var HEALTH_CHECK_DELAY_MS = 5000;
var CIRCUIT_BREAKER_THRESHOLD = 3; // 3 Failures = Stop
var CIRCUIT_BREAKER_RESET_HOURS = 2; // nach X h ohne Failures wieder freischalten (Auto-Reset)

// ── Pre-Deploy: Backup erstellen ────────────────────────────────

function preDeployBackup(appConfig) {
  var ts = new Date().toISOString().replace(/[:-]/g, '').split('.')[0];
  var results = { ok: true, backups: [], git_sha: null };

  try {
    // 1. Git SHA merken (fuer Rollback)
    var appDir = resolveAppDir(appConfig);
    if (appDir) {
      var sha = sshExec(appConfig, 'cd ' + appDir + ' && git rev-parse HEAD');
      results.git_sha = (sha || '').trim();
    }

    // 2. DB-Backup (fuer sql.js Apps)
    var dbFiles = findDbFiles(appConfig, appDir);
    dbFiles.forEach(function(dbPath) {
      var backupPath = dbPath + '.pre-deploy-' + ts;
      sshExec(appConfig, 'cp ' + dbPath + ' ' + backupPath);
      results.backups.push({ file: dbPath, backup: backupPath });
    });

    // 3. Backup-Info in DB speichern
    craDb.run(
      'INSERT INTO hook_events (hook_name, event_type, repo_name, details) VALUES (?,?,?,?)',
      ['deploy-safety', 'pre-deploy-backup', appConfig.repo || null,
       'SHA: ' + results.git_sha + ' | Backups: ' + results.backups.length]
    );
    craDb.saveCraDb();

    console.log('[CRA/Safety] Pre-Deploy Backup:', appConfig.id, '— SHA:', results.git_sha, '— Backups:', results.backups.length);
  } catch (e) {
    results.ok = false;
    results.error = e.message;
    console.error('[CRA/Safety] Backup-Fehler:', e.message);
  }

  return results;
}

// ── Post-Deploy: Health-Check ───────────────────────────────────

function postDeployHealthCheck(appConfig, callback) {
  var domain = appConfig.staging || appConfig.domain;
  if (!domain || domain === '-' || domain.indexOf('/') >= 0) {
    return callback(null, { healthy: true, skipped: true, reason: 'Keine pruefbare Domain' });
  }

  var url = 'https://' + domain + '/';
  var attempt = 0;

  function check() {
    attempt++;
    httpCheck(url, function(err, statusCode) {
      var healthy = !err && statusCode >= 200 && statusCode < 400;

      if (healthy) {
        console.log('[CRA/Safety] Health-Check OK:', domain, '— HTTP', statusCode, '— Versuch', attempt);
        return callback(null, { healthy: true, status_code: statusCode, attempts: attempt, domain: domain });
      }

      if (attempt < HEALTH_CHECK_RETRIES) {
        console.log('[CRA/Safety] Health-Check Retry:', domain, '— Versuch', attempt, '— Status:', statusCode || (err && err.message));
        setTimeout(check, HEALTH_CHECK_DELAY_MS);
      } else {
        console.error('[CRA/Safety] Health-Check FAILED:', domain, '— nach', attempt, 'Versuchen');
        callback(null, {
          healthy: false,
          status_code: statusCode || 0,
          error: err ? err.message : 'HTTP ' + statusCode,
          attempts: attempt,
          domain: domain
        });
      }
    });
  }

  check();
}

// ── Auto-Rollback ───────────────────────────────────────────────

function rollback(appConfig, gitSha, reason) {
  var appDir = resolveAppDir(appConfig);
  if (!appDir || !gitSha) {
    return { ok: false, error: 'Kein App-Dir oder SHA fuer Rollback' };
  }

  try {
    console.log('[CRA/Safety] ROLLBACK:', appConfig.id, '→', gitSha, '— Grund:', reason);

    // 1. Git checkout
    sshExec(appConfig, 'cd ' + appDir + ' && git checkout ' + gitSha + ' -- .');

    // 2. DB-Restore (letztes Backup suchen)
    var dbFiles = findDbFiles(appConfig, appDir);
    dbFiles.forEach(function(dbPath) {
      var latestBackup = sshExec(appConfig, 'ls -t ' + dbPath + '.pre-deploy-* 2>/dev/null | head -1');
      if (latestBackup && latestBackup.trim()) {
        sshExec(appConfig, 'cp ' + latestBackup.trim() + ' ' + dbPath);
        console.log('[CRA/Safety] DB restored:', dbPath);
      }
    });

    // 3. PM2 restart
    var pm2Name = appConfig.staging_pm2 || appConfig.pm2_name;
    var user = appConfig.staging_user || appConfig.user;
    if (pm2Name && user) {
      if (user === 'root') {
        sshExec(appConfig, 'pm2 restart ' + pm2Name);
      } else {
        sshExecAs(user, 'pm2 restart ' + pm2Name);
      }
    }

    // 4. In DB loggen
    craDb.run(
      'INSERT INTO hook_events (hook_name, event_type, repo_name, details) VALUES (?,?,?,?)',
      ['deploy-safety', 'rollback', appConfig.repo || null,
       'SHA: ' + gitSha + ' | Grund: ' + reason]
    );
    craDb.saveCraDb();

    return { ok: true, rolled_back_to: gitSha, app: appConfig.id };
  } catch (e) {
    console.error('[CRA/Safety] Rollback-Fehler:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Circuit Breaker ─────────────────────────────────────────────

function checkCircuitBreaker() {
  // Auto-Reset: Nur Sessions aus dem Reset-Fenster betrachten. Wenn die letzten
  // Failures älter als CIRCUIT_BREAKER_RESET_HOURS sind, ist der CB automatisch
  // frei — sonst bleibt er bis zu manueller Admin-Intervention ewig gestrippt.
  var recent = craDb.all(
    "SELECT * FROM dispatch_sessions WHERE started_at >= datetime('now', ?, 'localtime') " +
    "ORDER BY started_at DESC LIMIT ?",
    ['-' + CIRCUIT_BREAKER_RESET_HOURS + ' hours', CIRCUIT_BREAKER_THRESHOLD]
  );

  if (recent.length < CIRCUIT_BREAKER_THRESHOLD) return { tripped: false, consecutive_failures: 0 };

  var allFailed = recent.every(function(s) { return s.status === 'failed'; });

  if (allFailed) {
    // Smart-Recovery: Prüfe ob dasselbe Finding alle Failures verursacht
    var failedFindings = {};
    recent.forEach(function(s) {
      var fid = s.finding_id || 'unknown';
      failedFindings[fid] = (failedFindings[fid] || 0) + 1;
    });

    // Finde Finding das alle (oder die meisten) Failures verursacht
    var blocker = null;
    Object.keys(failedFindings).forEach(function(fid) {
      if (failedFindings[fid] >= 2) blocker = fid; // 2+ Failures = Blocker
    });

    if (blocker) {
      // Smart-Recovery: Blocker-Finding auf 'deferred' setzen statt alles stoppen
      var now = new Date().toISOString().replace('T', ' ').split('.')[0];
      craDb.run(
        "UPDATE findings SET status = 'deferred', updated_at = ? WHERE id = ?",
        [now, blocker]
      );

      // Nur einmal loggen
      var alreadyDeferred = craDb.get(
        "SELECT id FROM hook_events WHERE event_type = 'cb-smart-recovery' AND repo_name = ? AND created_at > ? LIMIT 1",
        [blocker, recent[recent.length - 1].started_at || '']
      );
      if (!alreadyDeferred) {
        craDb.run(
          'INSERT INTO hook_events (hook_name, event_type, repo_name, details) VALUES (?,?,?,?)',
          ['deploy-safety', 'cb-smart-recovery', blocker,
           'Finding ' + blocker + ' nach ' + failedFindings[blocker] + ' Failures auf deferred gesetzt. Dispatcher macht weiter.']
        );

        try {
          var craEscalation = require('./cra-escalation');
          craEscalation.escalate({
            trigger: 'circuit_breaker_recovery',
            severity: 'HIGH',
            context: {
              reason: 'Finding ' + blocker + ' verursacht ' + failedFindings[blocker] + '/' + CIRCUIT_BREAKER_THRESHOLD + ' Failures',
              action: 'Automatisch auf deferred gesetzt — manuelle Prüfung empfohlen',
              sessions: recent.map(function(s) { return s.id + ': ' + s.finding_id + ' → ' + (s.error_message || s.result); })
            },
            recommended_action: 'Finding ' + blocker + ' manuell im Dashboard prüfen. Möglicherweise fehlen description/fix Felder oder das Repo ist nicht erreichbar.'
          });
        } catch (e) { /* Eskalation optional */ }
      }

      // Failed Sessions resetten damit CB nicht erneut tripped
      recent.forEach(function(s) {
        if (s.finding_id === blocker && s.status === 'failed') {
          craDb.run("UPDATE dispatch_sessions SET status = 'completed', result = 'deferred', error_message = 'Smart-Recovery: Finding nach wiederholten Failures auf deferred gesetzt' WHERE id = ?", [s.id]);
        }
      });

      craDb.saveCraDb();
      console.log('[CRA/Safety] SMART RECOVERY: Finding', blocker, 'auf deferred —', failedFindings[blocker], 'Failures. Dispatcher läuft weiter.');
      return { tripped: false, consecutive_failures: 0, recovered: true, deferred_finding: blocker };
    }

    // Kein klarer Blocker (verschiedene Findings) — klassischer CB-Trip
    var alreadyTripped = craDb.get(
      "SELECT id FROM hook_events WHERE hook_name = 'deploy-safety' AND event_type = 'circuit-breaker-tripped' AND created_at > ? LIMIT 1",
      [recent[0].started_at || '']
    );

    if (!alreadyTripped) {
      console.error('[CRA/Safety] CIRCUIT BREAKER: ' + CIRCUIT_BREAKER_THRESHOLD + ' aufeinanderfolgende Failures (verschiedene Findings)!');

      craDb.run(
        'INSERT INTO hook_events (hook_name, event_type, details) VALUES (?,?,?)',
        ['deploy-safety', 'circuit-breaker-tripped', CIRCUIT_BREAKER_THRESHOLD + ' consecutive failures (diverse findings)']
      );

      try {
        var craEscalation2 = require('./cra-escalation');
        craEscalation2.escalate({
          trigger: 'cra_api_unreachable',
          severity: 'CRITICAL',
          context: {
            reason: 'Circuit Breaker: ' + CIRCUIT_BREAKER_THRESHOLD + ' verschiedene Findings fehlgeschlagen',
            sessions: recent.map(function(s) { return s.id + ': ' + s.finding_id + ' → ' + (s.error_message || s.result); })
          },
          recommended_action: 'Dispatcher gestoppt. Systemisches Problem — manuelles Review erforderlich.'
        });
      } catch (e) { /* Eskalation optional */ }

      craDb.saveCraDb();
    }

    return { tripped: true, consecutive_failures: CIRCUIT_BREAKER_THRESHOLD, sessions: recent.map(function(s) { return s.id; }) };
  }

  var consecutiveFails = 0;
  for (var i = 0; i < recent.length; i++) {
    if (recent[i].status === 'failed') consecutiveFails++;
    else break;
  }

  return { tripped: false, consecutive_failures: consecutiveFails };
}

// ── Vollstaendiger Safe-Deploy Flow ─────────────────────────────

function safeDeploy(appConfig, newSha, callback) {
  // 1. Circuit Breaker pruefen
  var cb = checkCircuitBreaker();
  if (cb.tripped) {
    return callback(null, { ok: false, step: 'circuit-breaker', reason: 'Circuit Breaker ausgeloest (' + cb.consecutive_failures + ' Failures)' });
  }

  // 2. Pre-Deploy Backup
  var backup = preDeployBackup(appConfig);
  if (!backup.ok) {
    return callback(null, { ok: false, step: 'backup', reason: 'Backup fehlgeschlagen: ' + backup.error });
  }

  // 3. Deploy ausfuehren
  var appDir = resolveAppDir(appConfig);
  try {
    sshExec(appConfig, 'cd ' + appDir + ' && git stash 2>/dev/null; git pull origin main');
    var pm2Name = appConfig.staging_pm2 || appConfig.pm2_name;
    var user = appConfig.staging_user || appConfig.user;
    if (pm2Name) {
      if (user === 'root') sshExec(appConfig, 'pm2 restart ' + pm2Name);
      else sshExecAs(user, 'pm2 restart ' + pm2Name);
    }
  } catch (e) {
    // Deploy fehlgeschlagen — sofort Rollback
    var rb = rollback(appConfig, backup.git_sha, 'Deploy-Fehler: ' + e.message);
    return callback(null, { ok: false, step: 'deploy', reason: e.message, rollback: rb });
  }

  // 4. Health-Check (async, mit Delay)
  setTimeout(function() {
    postDeployHealthCheck(appConfig, function(err, health) {
      if (health.healthy) {
        craDb.run(
          'INSERT INTO hook_events (hook_name, event_type, repo_name, details) VALUES (?,?,?,?)',
          ['deploy-safety', 'deploy-success', appConfig.repo || null,
           'Health OK: ' + health.domain + ' HTTP ' + health.status_code]
        );
        craDb.saveCraDb();
        callback(null, { ok: true, step: 'complete', health: health, backup: backup });
      } else {
        // Health-Check failed — Auto-Rollback
        console.error('[CRA/Safety] HEALTH FAILED — Auto-Rollback!');
        var rb = rollback(appConfig, backup.git_sha, 'Post-Deploy Health-Check failed: ' + (health.error || 'unbekannt'));

        craDb.run(
          'INSERT INTO hook_events (hook_name, event_type, repo_name, details) VALUES (?,?,?,?)',
          ['deploy-safety', 'auto-rollback', appConfig.repo || null,
           'Health failed → Rollback zu ' + backup.git_sha]
        );
        craDb.saveCraDb();

        callback(null, { ok: false, step: 'health-check', reason: health.error, rollback: rb, health: health });
      }
    });
  }, 3000); // 3s warten bis App hochgefahren ist
}

// ── Status abrufen ──────────────────────────────────────────────

function getStatus() {
  var cb = checkCircuitBreaker();
  var recentDeploys = craDb.all(
    "SELECT * FROM hook_events WHERE hook_name = 'deploy-safety' ORDER BY created_at DESC LIMIT 10"
  );
  return {
    circuit_breaker: cb,
    recent_events: recentDeploys,
    health_retries: HEALTH_CHECK_RETRIES,
    health_delay_ms: HEALTH_CHECK_DELAY_MS,
    cb_threshold: CIRCUIT_BREAKER_THRESHOLD
  };
}

// ── Hilfsfunktionen ─────────────────────────────────────────────

function resolveAppDir(appConfig) {
  if (!appConfig) return null;
  var user = appConfig.staging_user || appConfig.user;
  if (user === 'root') return process.env.MERIDIAN_BASE_PATH || '/opt/ks-management';
  var domain = appConfig.staging || appConfig.domain;
  if (!domain || domain === '-') return null;
  return '/home/' + user + '/htdocs/' + domain;
}

function findDbFiles(appConfig, appDir) {
  if (!appDir) return [];
  try {
    var result = sshExec(appConfig, 'find ' + appDir + '/data -name "*.db" -type f 2>/dev/null');
    return (result || '').split('\n').filter(function(f) { return f.trim().length > 0; });
  } catch (e) { return []; }
}

function sshExec(appConfig, cmd) {
  var result = child.spawnSync('ssh', ['root@' + (process.env.MERIDIAN_SERVER_HOST || 'localhost'), cmd], {
    encoding: 'utf8', timeout: 30000
  });
  if (result.error) throw result.error;
  return result.stdout || '';
}

function sshExecAs(user, cmd) {
  // Sanitize: nur alphanumerisch + Bindestrich + Unterstrich
  var safeUser = (user || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (safeUser !== user || !safeUser) {
    throw new Error('Ungueltiger Benutzername: ' + user);
  }
  return sshExec(null, "su - " + safeUser + " -c '" + cmd.replace(/'/g, "'\\''") + "'");
}

function httpCheck(url, callback) {
  var mod = url.startsWith('https') ? https : http;
  var req = mod.get(url, { timeout: 10000, rejectUnauthorized: false }, function(res) {
    callback(null, res.statusCode);
  });
  req.on('error', function(e) { callback(e, 0); });
  req.on('timeout', function() { req.destroy(); callback(new Error('timeout'), 0); });
}

// Manueller Reset (Admin-Dashboard): Alte fehlgeschlagene Sessions auf
// 'cb-reset-ack' markieren, sodass checkCircuitBreaker() sie ignoriert.
function resetCircuitBreaker(reason) {
  try {
    var affected = craDb.all(
      "SELECT id FROM dispatch_sessions WHERE status = 'failed' " +
      "AND started_at >= datetime('now', ?, 'localtime')",
      ['-' + CIRCUIT_BREAKER_RESET_HOURS + ' hours']
    );
    craDb.run(
      "UPDATE dispatch_sessions SET status = 'cb-reset-ack', " +
      "error_message = COALESCE(error_message, '') || ' [CB-Reset: ' || ? || ']' " +
      "WHERE status = 'failed' AND started_at >= datetime('now', ?, 'localtime')",
      [reason || 'manual', '-' + CIRCUIT_BREAKER_RESET_HOURS + ' hours']
    );
    craDb.run(
      'INSERT INTO hook_events (hook_name, event_type, details) VALUES (?,?,?)',
      ['deploy-safety', 'circuit-breaker-reset',
       (affected.length || 0) + ' Sessions auf cb-reset-ack gesetzt. Grund: ' + (reason || 'manual')]
    );
    craDb.saveCraDb();
    console.log('[CRA/Safety] CB RESET:', affected.length, 'Sessions freigegeben —', reason || 'manual');
    return { ok: true, sessions_reset: affected.length };
  } catch (e) {
    console.error('[CRA/Safety] CB-Reset-Fehler:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  preDeployBackup: preDeployBackup,
  postDeployHealthCheck: postDeployHealthCheck,
  rollback: rollback,
  checkCircuitBreaker: checkCircuitBreaker,
  resetCircuitBreaker: resetCircuitBreaker,
  safeDeploy: safeDeploy,
  getStatus: getStatus
};
