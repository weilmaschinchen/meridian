// admin/cra/forgejo-status.js — CRA → Forgejo Commit Status API
// Pendant zu github-status.js. Fire-and-forget, Fehler werden geloggt.
var https = require('https');
var http = require('http');
var urlMod = require('url');

var TOKEN = process.env.FORGEJO_CRA_TOKEN || '';
var FORGEJO_BASE = process.env.FORGEJO_BASE_URL || 'http://localhost:3000';
var FORGEJO_INTERNAL = process.env.FORGEJO_INTERNAL_URL || 'http://10.89.4.20:3010';
var CONTEXT = 'cra/gate';
var CONTEXT_2ND_PASS = 'cra/2nd-pass-review';
var DASHBOARD_BASE = process.env.CRA_DASHBOARD_BASE || 'http://localhost:3011/cra';
var tokenWarned = false;

function mapState(overallStatus) {
  switch (overallStatus) {
    case 'APPROVED': case 'OVERRIDDEN': case 'SUPERSEDED': case 'SKIPPED': return 'success';
    case 'BLOCKED': case 'REJECTED': return 'failure';
    case 'PENDING': return 'pending';
    default: return null;
  }
}

function buildDescription(result) {
  if (!result) return 'CRA: no analysis';
  if (result.overallStatus === 'SKIPPED') return 'CRA: disabled (kill switch)';
  var parts = [result.overallStatus || 'UNKNOWN'];
  if (typeof result.riskScore === 'number') parts.push('Score ' + result.riskScore);
  var cnt = (typeof result.findings === 'number') ? result.findings
    : (Array.isArray(result.findings) ? result.findings.length : null);
  if (cnt !== null && cnt > 0) parts.push(cnt + ' finding' + (cnt === 1 ? '' : 's'));
  var desc = parts.join(' · ');
  return desc.length > 140 ? desc.substring(0, 137) + '...' : desc;
}

// Postet einen Commit-Status an Forgejo. Forgejo-API ist GitHub-kompatibel:
// POST /api/v1/repos/{owner}/{repo}/statuses/{sha}
// States: pending | success | error | failure | warning
function postStatus(opts) {
  return new Promise(function(resolve) {
    var repoFullName = opts.repo; // "owner/repo"
    var sha = opts.sha;
    var state = opts.state;
    var description = opts.description;
    var targetUrl = opts.targetUrl;
    var context = opts.context || CONTEXT;

    if (!TOKEN) {
      if (!tokenWarned) {
        console.warn('[CRA/ForgejoStatus] FORGEJO_CRA_TOKEN nicht gesetzt — Forgejo-Status deaktiviert');
        tokenWarned = true;
      }
      return resolve({ ok: false, skipped: true, reason: 'no-token' });
    }
    if (!repoFullName || !sha || !state) {
      return resolve({ ok: false, reason: 'incomplete' });
    }

    var body = JSON.stringify({
      state: state,
      target_url: targetUrl || DASHBOARD_BASE,
      description: description || ('CRA ' + state),
      context: context
    });

    var parsed = urlMod.parse(FORGEJO_BASE);
    var isHttps = parsed.protocol === 'https:';
    var mod = isHttps ? https : http;
    var apiPath = '/api/v1/repos/' + repoFullName + '/statuses/' + sha;

    var req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: apiPath,
      method: 'POST',
      headers: {
        'Authorization': 'token ' + TOKEN,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'CRA-ForgejoStatus/1.0'
      }
    }, function(r) {
      var buf = '';
      r.on('data', function(c) { buf += c; });
      r.on('end', function() {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          resolve({ ok: true, status: r.statusCode });
        } else {
          console.warn('[CRA/ForgejoStatus] HTTP', r.statusCode, apiPath, buf.substring(0, 200));
          resolve({ ok: false, status: r.statusCode });
        }
      });
    });
    req.on('error', function(e) {
      console.warn('[CRA/ForgejoStatus] Request-Error:', e.message);
      resolve({ ok: false, error: e.message });
    });
    req.write(body);
    req.end();
  });
}

function postFromAnalysis(opts) {
  var repoFullName = opts.repoFullName;
  var sha = opts.sha;
  var result = opts.result;
  if (!repoFullName || !sha) return Promise.resolve({ ok: false });
  var state = (result && result.overallStatus) ? mapState(result.overallStatus) : 'error';
  if (!state) return Promise.resolve({ ok: false, reason: 'unmapped status' });
  var rfcId = result && result.rfcId;
  return postStatus({
    repo: repoFullName,
    sha: sha,
    state: state,
    description: buildDescription(result),
    targetUrl: rfcId ? (DASHBOARD_BASE + '#rfc-' + rfcId.toLowerCase()) : DASHBOARD_BASE
  });
}

// ADR-0029 analog: cra/2nd-pass-review Status initial posten
function post2ndPassInitial(opts) {
  var result = opts.result;
  var needsReview = result && ['HIGH', 'CRITICAL', 'MEDIUM'].indexOf(result.riskLevel) !== -1;
  if (!needsReview) {
    return postStatus({
      repo: opts.repoFullName, sha: opts.sha, state: 'success',
      description: '2nd-Pass nicht erforderlich (' + (result && result.riskLevel || 'LOW') + ')',
      context: CONTEXT_2ND_PASS
    });
  }
  return postStatus({
    repo: opts.repoFullName, sha: opts.sha, state: 'pending',
    description: '2nd-Pass läuft (' + (result && result.riskLevel) + ')',
    context: CONTEXT_2ND_PASS
  });
}

// Race-Condition Mitigation v2: interne Clone-URL für git fetch
// (Forgejo-Container direkt via podman-Netz, kein GitHub-Mirror-Lag)
function getInternalCloneUrl(repoFullName) {
  if (!TOKEN || !repoFullName) return null;
  // Format: http://user:token@container-ip:port/owner/repo.git
  var base = FORGEJO_INTERNAL.replace(/^(https?:\/\/)/, '$1forgejo-cra:' + TOKEN + '@');
  return base.replace(/\/$/, '') + '/' + repoFullName + '.git';
}

module.exports = { postStatus, postFromAnalysis, post2ndPassInitial, getInternalCloneUrl };
