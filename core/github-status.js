// admin/cra/github-status.js — CRA → GitHub Status Checks API
// Postet den Analyse-Status als Commit Status nach GitHub. Fire-and-forget.
var https = require('https');

var TOKEN = process.env.GITHUB_CRA_TOKEN || '';
var CONTEXT = 'cra/gate';
// ADR-0029 Phase 2a (2026-05-05): zweiter Required-Status-Check für 2nd-Pass-Re-Eval.
// Initial 'pending' nach 1st-Pass für HIGH/CRITICAL/MEDIUM-Kandidaten,
// Final 'success'/'failure' nach reEvaluateStatus().
var CONTEXT_2ND_PASS = 'cra/2nd-pass-review';
var DASHBOARD_BASE = process.env.CRA_DASHBOARD_BASE || 'https://backup.kurvenschule.cloud/cra';
var tokenWarned = false;

// CRA overallStatus → GitHub status state
function mapState(overallStatus) {
  switch (overallStatus) {
    case 'APPROVED':
    case 'OVERRIDDEN':
    case 'SUPERSEDED':
    case 'SKIPPED':
      return 'success';
    case 'BLOCKED':
    case 'REJECTED':
      return 'failure';
    case 'PENDING':
      return 'pending';
    default:
      return null;
  }
}

function buildDescription(result) {
  if (!result) return 'CRA: no analysis';
  if (result.overallStatus === 'SKIPPED') return 'CRA: disabled (kill switch)';
  var parts = [];
  parts.push(result.overallStatus || 'UNKNOWN');
  if (typeof result.riskScore === 'number') parts.push('Score ' + result.riskScore);
  var findingsCount = (typeof result.findings === 'number') ? result.findings : (Array.isArray(result.findings) ? result.findings.length : null);
  if (findingsCount !== null && findingsCount > 0) parts.push(findingsCount + ' finding' + (findingsCount === 1 ? '' : 's'));
  var desc = parts.join(' · ');
  return desc.length > 140 ? desc.substring(0, 137) + '...' : desc;
}

// Postet einen Status Check an GitHub. Return Promise (resolve IMMER,
// reject nur bei Missbrauch). Fehler werden geloggt, nicht geworfen.
function postStatus(opts) {
  return new Promise(function(resolve) {
    var repo = opts.repo;
    var sha = opts.sha;
    var state = opts.state;
    var description = opts.description;
    var targetUrl = opts.targetUrl;
    var context = opts.context || CONTEXT;

    if (!TOKEN) {
      if (!tokenWarned) {
        console.warn('[CRA/GitHubStatus] GITHUB_CRA_TOKEN nicht gesetzt — Status Checks deaktiviert');
        tokenWarned = true;
      }
      return resolve({ ok: false, skipped: true, reason: 'no-token' });
    }
    if (!repo || !sha || !state) {
      console.warn('[CRA/GitHubStatus] Incomplete payload:', { repo: !!repo, sha: !!sha, state: !!state });
      return resolve({ ok: false, reason: 'incomplete' });
    }

    var body = JSON.stringify({
      state: state,
      target_url: targetUrl || DASHBOARD_BASE,
      description: description || ('CRA ' + state),
      context: context
    });

    var req = https.request({
      hostname: 'api.github.com',
      path: '/repos/' + repo + '/statuses/' + sha,
      method: 'POST',
      headers: {
        'Authorization': 'token ' + TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'cra-status-bot',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 8000
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('[CRA/GitHubStatus]', repo, sha.substring(0, 8), state, context, '→', res.statusCode);
          resolve({ ok: true, statusCode: res.statusCode });
        } else {
          var responseBody = Buffer.concat(chunks).toString('utf8').substring(0, 200);
          console.warn('[CRA/GitHubStatus] Fehler', res.statusCode, repo, sha.substring(0, 8), '→', responseBody);
          resolve({ ok: false, statusCode: res.statusCode, body: responseBody });
        }
      });
    });

    req.on('error', function(err) {
      console.warn('[CRA/GitHubStatus] Request-Error:', repo, sha.substring(0, 8), err.message);
      resolve({ ok: false, error: err.message });
    });

    req.on('timeout', function() {
      req.destroy();
      console.warn('[CRA/GitHubStatus] Timeout:', repo, sha.substring(0, 8));
      resolve({ ok: false, error: 'timeout' });
    });

    req.write(body);
    req.end();
  });
}

// Convenience: Postet Status aus einem runAnalysis()-Ergebnis
function postFromAnalysis(opts) {
  var fullName = opts.repoFullName;
  var sha = opts.sha;
  var result = opts.result;

  if (!fullName || !sha) {
    return Promise.resolve({ ok: false, reason: 'no-repo-or-sha' });
  }

  var state, description, targetUrl;

  if (!result) {
    state = 'success';
    description = 'CRA: no diff analyzed';
    targetUrl = DASHBOARD_BASE;
  } else {
    state = mapState(result.overallStatus);
    if (!state) {
      return Promise.resolve({ ok: false, reason: 'unmapped-status:' + result.overallStatus });
    }
    description = buildDescription(result);
    targetUrl = result.rfcId
      ? DASHBOARD_BASE + '#rfc-' + result.rfcId
      : DASHBOARD_BASE;
  }

  return postStatus({
    repo: fullName,
    sha: sha,
    state: state,
    description: description,
    targetUrl: targetUrl
  });
}

// ── ADR-0029 Phase 2a: 2nd-Pass-Review-Status ─────────────────────────
// Postet `cra/2nd-pass-review` als eigenen Status-Check.
// Kandidatenfilter (severity HIGH/CRITICAL/MEDIUM) wird im Aufrufer entschieden;
// hier nur das Mapping vom RFC-Re-Eval-Ergebnis zum GitHub-State.

function mapStateFor2ndPassResult(rfc) {
  if (!rfc) return { state: 'success', description: 'CRA 2nd-Pass: no RFC' };
  var os = rfc.overall_status;
  var reEvalReason = rfc.status_re_eval_reason || '';
  var sev2 = rfc.llm_review_2nd_severity || '';
  var rfcId = rfc.id;

  // Eskalation per ADR-0029-Härtung blockiert
  if (os === 'BLOCKED' && (reEvalReason === 'esk-critical' || reEvalReason === 'esk-high')) {
    return { state: 'failure', description: '2nd-Pass eskaliert (' + sev2 + '): ' + reEvalReason };
  }
  if (os === 'NEEDS_REVIEW' || reEvalReason === 'esk-medium-from-low') {
    return { state: 'failure', description: '2nd-Pass NEEDS_REVIEW (' + sev2 + ')' };
  }
  // De-Eskalations-Hint: Status bleibt BLOCKED, aber 2nd-Pass-Check passt
  if (reEvalReason === 'de-esk-hint') {
    return { state: 'success', description: '2nd-Pass de-eskaliert (Hint)' };
  }
  // 2nd-Pass-Worker noch nicht durchgelaufen
  if (rfc.llm_review_2nd_status === null || rfc.llm_review_2nd_status === undefined) {
    return { state: 'pending', description: '2nd-Pass-Verifikation läuft' };
  }
  // agree-with-1st oder no_run nach Doc-Only-Skip → success
  return { state: 'success', description: '2nd-Pass ' + (rfc.llm_review_2nd_status || 'no_run') };
}

// Initial-Post nach 1st-Pass: pending wenn 2nd-Pass-Kandidat, sonst success.
// Kandidat = severity HIGH/CRITICAL/MEDIUM ODER risk_level HIGH/CRITICAL/MEDIUM.
function post2ndPassInitial(opts) {
  var repoFullName = opts.repoFullName;
  var sha = opts.sha;
  var result = opts.result;
  if (!repoFullName || !sha) return Promise.resolve({ ok: false, reason: 'no-repo-or-sha' });

  var sev = String((result && result.llmSeverity) || '').toUpperCase();
  var rl = String((result && result.riskLevel) || '').toUpperCase();
  var is2ndPassCandidate = ['HIGH','CRITICAL','MEDIUM'].indexOf(sev) !== -1
                        || ['HIGH','CRITICAL','MEDIUM'].indexOf(rl) !== -1;

  var state = is2ndPassCandidate ? 'pending' : 'success';
  var description = is2ndPassCandidate
    ? '2nd-Pass-Verifikation eingereiht (' + (sev || rl) + ')'
    : '2nd-Pass nicht erforderlich (' + (sev || rl || 'LOW') + ')';
  var targetUrl = result && result.rfcId
    ? DASHBOARD_BASE + '#rfc-' + result.rfcId
    : DASHBOARD_BASE;

  return postStatus({
    repo: repoFullName, sha: sha, state: state,
    description: description, targetUrl: targetUrl,
    context: CONTEXT_2ND_PASS
  });
}

// Final-Post nach reEvaluateStatus(): mappt RFC-Zustand auf GitHub-State.
function post2ndPassFinal(rfc) {
  if (!rfc || !rfc.commit_sha || !rfc.repo_full_name) {
    return Promise.resolve({ ok: false, reason: 'no-repo-or-sha' });
  }
  var mapped = mapStateFor2ndPassResult(rfc);
  return postStatus({
    repo: rfc.repo_full_name, sha: rfc.commit_sha, state: mapped.state,
    description: mapped.description,
    targetUrl: DASHBOARD_BASE + '#rfc-' + rfc.id,
    context: CONTEXT_2ND_PASS
  });
}

module.exports = {
  postStatus, postFromAnalysis, mapState, buildDescription,
  post2ndPassInitial, post2ndPassFinal, mapStateFor2ndPassResult,
  CONTEXT_2ND_PASS: CONTEXT_2ND_PASS
};
