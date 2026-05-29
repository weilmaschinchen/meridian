// admin/cra/github-checks.js — Cache fuer GitHub check_run / check_suite / pull_request Events
var craDb = require('./cra-db');
var https = require('https');

var GH_TOKEN = process.env.GITHUB_CRA_TOKEN || '';

// Getrackte Repos aus ENV (Dependabot-Sync). CRA Plus setzt MERIDIAN_GITHUB_REPOS
// (JSON-Array "owner/repo"); OSS-Default = leer.
var TRACKED_REPOS = (function () {
  try { return JSON.parse(process.env.MERIDIAN_GITHUB_REPOS || '[]'); } catch (e) { return []; }
})();

function nowTs() {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

// check_run Event → upsert in gh_checks
function upsertCheckRun(payload) {
  var cr = payload.check_run;
  var repo = payload.repository;
  if (!cr || !repo) return { ok: false, reason: 'missing-fields' };

  var repoFullName = repo.full_name;
  var sha = cr.head_sha;
  var name = cr.name || 'unknown';
  var status = cr.status || 'unknown';
  var conclusion = cr.conclusion || null;
  var detailsUrl = cr.details_url || cr.html_url || null;
  var raw = JSON.stringify({ action: payload.action, check_run: { id: cr.id, status: status, conclusion: conclusion, started_at: cr.started_at, completed_at: cr.completed_at } });
  var ts = nowTs();

  craDb.run(
    `INSERT INTO gh_checks (repo_full_name, sha, check_name, check_run_id, status, conclusion, details_url, source, raw_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(repo_full_name, sha, check_name) DO UPDATE SET
       check_run_id = excluded.check_run_id,
       status = excluded.status,
       conclusion = excluded.conclusion,
       details_url = excluded.details_url,
       source = excluded.source,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`,
    [repoFullName, sha, name, cr.id, status, conclusion, detailsUrl, 'check_run', raw, ts, ts]
  );

  return { ok: true, repo: repoFullName, sha: sha.substring(0, 8), name: name, status: status, conclusion: conclusion };
}

// check_suite Event → wird nur bei completed geloggt (Aggregat-Status, low priority)
function recordCheckSuite(payload) {
  var cs = payload.check_suite;
  var repo = payload.repository;
  if (!cs || !repo) return { ok: false, reason: 'missing-fields' };
  if (payload.action !== 'completed') return { ok: true, skipped: true, reason: 'not-completed' };

  var repoFullName = repo.full_name;
  var sha = cs.head_sha;
  var name = '_check_suite';
  var status = cs.status || 'completed';
  var conclusion = cs.conclusion || null;
  var raw = JSON.stringify({ action: payload.action, check_suite: { id: cs.id, status: status, conclusion: conclusion, app: cs.app && cs.app.slug } });
  var ts = nowTs();

  craDb.run(
    `INSERT INTO gh_checks (repo_full_name, sha, check_name, check_run_id, status, conclusion, details_url, source, raw_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(repo_full_name, sha, check_name) DO UPDATE SET
       status = excluded.status,
       conclusion = excluded.conclusion,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`,
    [repoFullName, sha, name, null, status, conclusion, null, 'check_suite', raw, ts, ts]
  );

  return { ok: true, repo: repoFullName, sha: sha.substring(0, 8), conclusion: conclusion };
}

// pull_request Event → upsert in gh_pulls
function recordPullRequest(payload) {
  var pr = payload.pull_request;
  var repo = payload.repository;
  if (!pr || !repo) return { ok: false, reason: 'missing-fields' };

  var action = payload.action;
  // Wir interessieren uns nur fuer Aktionen die head_sha relevant machen
  var relevantActions = ['opened', 'synchronize', 'reopened', 'closed', 'edited', 'ready_for_review'];
  if (relevantActions.indexOf(action) === -1) return { ok: true, skipped: true, reason: 'irrelevant-action:' + action };

  var repoFullName = repo.full_name;
  var prNumber = pr.number;
  var headSha = pr.head && pr.head.sha;
  var baseSha = pr.base && pr.base.sha;
  var state = pr.state || 'unknown';
  var title = (pr.title || '').substring(0, 200);
  var htmlUrl = pr.html_url || null;
  var ts = nowTs();

  if (!headSha) return { ok: false, reason: 'no-head-sha' };

  craDb.run(
    `INSERT INTO gh_pulls (repo_full_name, pr_number, head_sha, base_sha, state, title, html_url, action, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(repo_full_name, pr_number, head_sha) DO UPDATE SET
       base_sha = excluded.base_sha,
       state = excluded.state,
       title = excluded.title,
       html_url = excluded.html_url,
       action = excluded.action,
       updated_at = excluded.updated_at`,
    [repoFullName, prNumber, headSha, baseSha, state, title, htmlUrl, action, ts, ts]
  );

  return { ok: true, repo: repoFullName, pr: prNumber, sha: headSha.substring(0, 8), state: state, action: action };
}

// API: Alle Checks fuer einen SHA
function getChecksForSha(repoFullName, sha) {
  return craDb.all(
    `SELECT check_name, check_run_id, status, conclusion, details_url, source, updated_at
     FROM gh_checks WHERE repo_full_name = ? AND sha = ?
     ORDER BY check_name`,
    [repoFullName, sha]
  );
}

// API: Checks zu einem RFC (joined ueber commit_sha + repo_full_name)
function getChecksForRfc(rfcId) {
  var rfc = craDb.get(
    `SELECT id, commit_sha, repo_full_name FROM rfc_runs WHERE id = ?`,
    [rfcId]
  );
  if (!rfc || !rfc.commit_sha || !rfc.repo_full_name) {
    return { rfc: rfc || null, checks: [], pull: null };
  }
  var checks = getChecksForSha(rfc.repo_full_name, rfc.commit_sha);
  var pull = craDb.get(
    `SELECT pr_number, state, title, html_url, action, updated_at
     FROM gh_pulls WHERE repo_full_name = ? AND head_sha = ?
     ORDER BY updated_at DESC LIMIT 1`,
    [rfc.repo_full_name, rfc.commit_sha]
  );
  return { rfc: rfc, checks: checks, pull: pull };
}

// API: Aggregierte Check-Summary fuer eine Liste von RFC-IDs
// Filtert _check_suite raus (Aggregat). Rueckgabe: { rfcId: {pass, fail, pending, total} }
function getChecksSummaryForRfcs(rfcIds) {
  var out = {};
  if (!Array.isArray(rfcIds) || !rfcIds.length) return out;
  var safeIds = rfcIds.filter(function(x){ return typeof x === 'string' && /^[A-Z0-9-]+$/i.test(x); });
  if (!safeIds.length) return out;
  var placeholders = safeIds.map(function(){ return '?'; }).join(',');
  var rfcs = craDb.all(
    'SELECT id, commit_sha, repo_full_name FROM rfc_runs WHERE id IN (' + placeholders + ')',
    safeIds
  );
  rfcs.forEach(function(rfc) {
    out[rfc.id] = { pass: 0, fail: 0, pending: 0, total: 0, sha: rfc.commit_sha, repo: rfc.repo_full_name };
    if (!rfc.commit_sha || !rfc.repo_full_name) return;
    var checks = craDb.all(
      "SELECT status, conclusion FROM gh_checks WHERE repo_full_name = ? AND sha = ? AND check_name != '_check_suite'",
      [rfc.repo_full_name, rfc.commit_sha]
    );
    checks.forEach(function(c) {
      out[rfc.id].total++;
      if (c.status !== 'completed') out[rfc.id].pending++;
      else if (c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped') out[rfc.id].pass++;
      else out[rfc.id].fail++;
    });
  });
  return out;
}

// API: Security-Tab Aggregation — pro Repo der LATEST SHA + sein Check-Status
function getRepoStatusOverview() {
  // Letzter SHA pro Repo (max updated_at in gh_checks)
  var rows = craDb.all(
    "SELECT repo_full_name, sha, MAX(updated_at) as latest FROM gh_checks WHERE check_name != '_check_suite' GROUP BY repo_full_name, sha ORDER BY latest DESC"
  );
  var seenRepo = {};
  var perRepo = [];
  rows.forEach(function(r) {
    if (seenRepo[r.repo_full_name]) return;
    seenRepo[r.repo_full_name] = true;
    var checks = craDb.all(
      "SELECT status, conclusion FROM gh_checks WHERE repo_full_name = ? AND sha = ? AND check_name != '_check_suite'",
      [r.repo_full_name, r.sha]
    );
    var s = { pass: 0, fail: 0, pending: 0, total: checks.length };
    checks.forEach(function(c) {
      if (c.status !== 'completed') s.pending++;
      else if (c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped') s.pass++;
      else s.fail++;
    });
    var light = 'gray';
    if (s.fail > 0) light = 'red';
    else if (s.pending > 0) light = 'yellow';
    else if (s.pass > 0) light = 'green';
    perRepo.push({
      repo: r.repo_full_name,
      sha: r.sha,
      latest: r.latest,
      checks: s,
      traffic_light: light
    });
  });
  return perRepo;
}

// API: Recent failing checks (letzte N Stunden)
function getRecentFailures(opts) {
  var hours = (opts && opts.hours) || 24;
  var limit = Math.min((opts && opts.limit) || 20, 100);
  var cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString().replace('T', ' ').split('.')[0];
  return craDb.all(
    `SELECT c.repo_full_name as repo, c.sha, c.check_name, c.conclusion, c.details_url, c.updated_at,
            p.pr_number, p.html_url as pr_url
     FROM gh_checks c
     LEFT JOIN gh_pulls p ON p.repo_full_name = c.repo_full_name AND p.head_sha = c.sha
     WHERE c.status = 'completed'
       AND c.conclusion IN ('failure','timed_out','action_required','cancelled')
       AND c.check_name != '_check_suite'
       AND c.updated_at >= ?
     ORDER BY c.updated_at DESC
     LIMIT ?`,
    [cutoff, limit]
  );
}

// API: Aggregierte Stats fuer das Security-Dashboard
function getSecurityStats() {
  var hour24ago = new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace('T', ' ').split('.')[0];
  var totalRuns = craDb.get(
    "SELECT COUNT(*) as cnt FROM gh_checks WHERE check_name != '_check_suite' AND updated_at >= ?",
    [hour24ago]
  );
  var failRuns = craDb.get(
    "SELECT COUNT(*) as cnt FROM gh_checks WHERE check_name != '_check_suite' AND status = 'completed' AND conclusion IN ('failure','timed_out','action_required') AND updated_at >= ?",
    [hour24ago]
  );
  var openPulls = craDb.get(
    "SELECT COUNT(*) as cnt FROM gh_pulls WHERE state = 'open'"
  );
  var repos = getRepoStatusOverview();
  var reposRed = repos.filter(function(r){return r.traffic_light==='red';}).length;
  var reposYellow = repos.filter(function(r){return r.traffic_light==='yellow';}).length;
  var reposGreen = repos.filter(function(r){return r.traffic_light==='green';}).length;
  var t = totalRuns ? totalRuns.cnt : 0;
  var f = failRuns ? failRuns.cnt : 0;
  return {
    total_runs_24h: t,
    fail_runs_24h: f,
    fail_rate_pct: t > 0 ? Math.round((f / t) * 100) : 0,
    open_pulls: openPulls ? openPulls.cnt : 0,
    repos_total: repos.length,
    repos_red: reposRed,
    repos_yellow: reposYellow,
    repos_green: reposGreen
  };
}

// ── Dependabot Alerts Sync (Phase 0.5, 2026-04-25) ──────────────────────────
// GitHub API: GET /repos/:owner/:repo/dependabot/alerts
// Token-Permission: "Dependabot alerts: Read" (Fine-grained PAT) — falls fehlt: 403.
// Wir paginieren bis state=all komplett gezogen ist, persistieren via UPSERT.
function ghApiRequest(path) {
  return new Promise(function(resolve) {
    if (!GH_TOKEN) return resolve({ status: 0, error: 'no-token', body: null });
    var opts = {
      hostname: 'api.github.com',
      path: path,
      method: 'GET',
      headers: {
        'Authorization': 'token ' + GH_TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'cra-dependabot-sync/1.0',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      timeout: 15000
    };
    var req = https.request(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        var parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch (e) {}
        resolve({ status: res.statusCode, body: parsed, raw: body });
      });
    });
    req.on('error', function(e) { resolve({ status: 0, error: e.message, body: null }); });
    req.on('timeout', function() { req.destroy(); resolve({ status: 0, error: 'timeout', body: null }); });
    req.end();
  });
}

function upsertDependabotAlert(repoFullName, alert) {
  var pkg = (alert.security_vulnerability && alert.security_vulnerability.package) || {};
  var firstFix = alert.security_vulnerability && alert.security_vulnerability.first_patched_version;
  var advisory = alert.security_advisory || {};
  craDb.run(
    `INSERT INTO gh_dependabot_alerts (repo_full_name, alert_number, state, severity, package_name, package_ecosystem, cve_id, ghsa_id, summary, html_url, fixed_in, dismissed_reason, auto_dismissed_at, raw_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(repo_full_name, alert_number) DO UPDATE SET
       state = excluded.state,
       severity = excluded.severity,
       fixed_in = excluded.fixed_in,
       dismissed_reason = excluded.dismissed_reason,
       auto_dismissed_at = excluded.auto_dismissed_at,
       fetched_at = datetime('now','localtime'),
       raw_json = excluded.raw_json`,
    [repoFullName, alert.number, alert.state || 'unknown',
     advisory.severity || (alert.security_vulnerability && alert.security_vulnerability.severity) || null,
     pkg.name || null, pkg.ecosystem || null,
     advisory.cve_id || null, advisory.ghsa_id || null,
     (advisory.summary || '').substring(0, 500),
     alert.html_url || null,
     firstFix ? firstFix.identifier : null,
     alert.dismissed_reason || null, alert.auto_dismissed_at || null,
     JSON.stringify({ created_at: alert.created_at, updated_at: alert.updated_at, dependency: alert.dependency }).substring(0, 2000)]
  );
}

async function syncDependabotForRepo(repoFullName) {
  var page = 1;
  var perPage = 100;
  var imported = 0;
  var error = null;
  while (true) {
    var result = await ghApiRequest('/repos/' + repoFullName + '/dependabot/alerts?state=all&per_page=' + perPage + '&page=' + page);
    if (result.status === 401 || result.status === 403) {
      error = 'permission-denied (status ' + result.status + ' — Token braucht "Dependabot alerts: Read")';
      break;
    }
    if (result.status === 404) { error = 'no-access-or-disabled'; break; }
    if (result.status !== 200 || !Array.isArray(result.body)) {
      error = 'http-' + result.status + (result.error ? ': ' + result.error : '');
      break;
    }
    if (!result.body.length) break;
    result.body.forEach(function(a) { try { upsertDependabotAlert(repoFullName, a); imported++; } catch (e) { /* skip broken */ } });
    if (result.body.length < perPage) break;
    page++;
    if (page > 20) break; // hard cap 2000 alerts/repo
  }
  return { repo: repoFullName, imported: imported, error: error };
}

async function syncAllDependabotAlerts() {
  var results = [];
  for (var i = 0; i < TRACKED_REPOS.length; i++) {
    var r = await syncDependabotForRepo(TRACKED_REPOS[i]);
    results.push(r);
  }
  try { craDb.saveCraDb(); } catch (e) {}
  // Audit-Trail
  try {
    var summary = results.map(function(r) { return r.repo.split('/')[1] + ':' + (r.error ? 'ERR(' + r.error + ')' : r.imported); }).join(' | ');
    craDb.run(
      'INSERT INTO hook_events (hook_name, event_type, repo_name, details) VALUES (?,?,?,?)',
      ['dependabot-sync', 'fetch-all', '_system_', summary.substring(0, 500)]
    );
    craDb.saveCraDb();
  } catch (e) {}
  console.log('[CRA/Dependabot] Sync complete:', results.length, 'repos —', results.reduce(function(s, r) { return s + r.imported; }, 0), 'alerts upserted');
  return results;
}

function getDependabotStats() {
  var openCounts = craDb.all(
    "SELECT severity, COUNT(*) as cnt FROM gh_dependabot_alerts WHERE state = 'open' GROUP BY severity"
  );
  var byRepo = craDb.all(
    "SELECT repo_full_name, severity, COUNT(*) as cnt FROM gh_dependabot_alerts WHERE state = 'open' GROUP BY repo_full_name, severity ORDER BY repo_full_name"
  );
  return { open_by_severity: openCounts, open_by_repo: byRepo };
}

// ── Retention: gh_checks + gh_pulls (Phase 0.4, 2026-04-25) ──────────────────
// Loescht GitHub Webhook-Cache-Eintraege aelter als RETENTION_DAYS (default 90).
// Beim 1. Versuch hatte CRA cleanupOldChecks als CRITICAL/Score 20 geblockt
// ("Destruktive Operation"). Loesung hier:
// - Expliziter WHERE-Filter mit datetime() (kein DELETE FROM ohne WHERE)
// - PRs/abgeschlossene Checks bleiben — wir loeschen NUR check-Eintraege fuer
//   Repo+SHA, deren PR nicht mehr OPEN ist und letzte Aktivitaet > N Tage
// - In-Run, kein OS-Cron (nutzt setInterval-Pattern wie ElevenLabs-Check oben)
// - Logging aller Loesch-Operationen via cra-db hook_events (Audit-Trail)
function cleanupOldGhData(retentionDays) {
  var days = parseInt(retentionDays || 90);
  if (days < 7) days = 7; // Hard-Floor: weniger als 1 Woche nie
  var cutoff = "datetime('now','localtime','-" + days + " days')";

  // Pull-Requests: nur DELETE wenn PR im closed-State + alt
  var pullsResult;
  try {
    pullsResult = craDb.run(
      "DELETE FROM gh_pulls WHERE state IN ('closed','merged') AND updated_at < " + cutoff
    );
  } catch (e) {
    console.error('[CRA/Retention] gh_pulls DELETE Fehler:', e.message);
    pullsResult = { changes: 0 };
  }

  // Checks: nur DELETE wenn check completed + alt + zugehoeriger PR (falls vorhanden) closed
  var checksResult;
  try {
    checksResult = craDb.run(
      "DELETE FROM gh_checks WHERE status = 'completed' AND updated_at < " + cutoff +
      " AND NOT EXISTS (SELECT 1 FROM gh_pulls p WHERE p.repo_full_name = gh_checks.repo_full_name AND p.head_sha = gh_checks.sha AND p.state = 'open')"
    );
  } catch (e) {
    console.error('[CRA/Retention] gh_checks DELETE Fehler:', e.message);
    checksResult = { changes: 0 };
  }

  var pullsDeleted = pullsResult.changes || 0;
  var checksDeleted = checksResult.changes || 0;

  // Audit-Trail
  try {
    craDb.run(
      'INSERT INTO hook_events (hook_name, event_type, repo_name, details) VALUES (?,?,?,?)',
      ['retention', 'gh-data-cleanup', '_system_',
       'Retention=' + days + 'd | Pulls deleted: ' + pullsDeleted + ' | Checks deleted: ' + checksDeleted]
    );
    craDb.saveCraDb();
  } catch (e) { /* Audit-Logging-Fehler nicht eskalieren */ }

  console.log('[CRA/Retention] gh-data cleanup:', pullsDeleted, 'PRs +', checksDeleted, 'Checks (>', days, 'Tage)');
  return { pullsDeleted: pullsDeleted, checksDeleted: checksDeleted, retentionDays: days };
}

module.exports = {
  upsertCheckRun: upsertCheckRun,
  recordCheckSuite: recordCheckSuite,
  recordPullRequest: recordPullRequest,
  getChecksForSha: getChecksForSha,
  getChecksForRfc: getChecksForRfc,
  getChecksSummaryForRfcs: getChecksSummaryForRfcs,
  getRepoStatusOverview: getRepoStatusOverview,
  getRecentFailures: getRecentFailures,
  getSecurityStats: getSecurityStats,
  syncDependabotForRepo: syncDependabotForRepo,
  syncAllDependabotAlerts: syncAllDependabotAlerts,
  getDependabotStats: getDependabotStats,
  cleanupOldGhData: cleanupOldGhData
};
