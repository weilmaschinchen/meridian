// SPDX-License-Identifier: Apache-2.0
// meridian/adapters/gitlab-webhook.js
// Inbound-Adapter: GitLab Webhook → Change Record (domain=devops)
//
// Unterstützte Events: Push Hook, Merge Request Hook, Tag Push Hook
//
// Konfiguration (ENV oder meridian.config.json):
//   MERIDIAN_GITLAB_SECRET   — Webhook-Secret (X-Gitlab-Token Header)
//   MERIDIAN_GITLAB_URL      — GitLab-Instanz URL (Default: https://gitlab.com)

'use strict';

var crypto = require('crypto');

var GITLAB_SECRET = process.env.MERIDIAN_GITLAB_SECRET || '';
var GITLAB_URL    = process.env.MERIDIAN_GITLAB_URL    || 'https://gitlab.com';

// ── Adapter-Interface ──────────────────────────────────────────────

/**
 * ingest(rawPayload, headers) → ChangeRecord | null
 * Wandelt GitLab-Webhook-Payload in Meridian Change Record um.
 */
function ingest(rawPayload, headers) {
  // Token-Verifikation
  if (GITLAB_SECRET) {
    var token = headers['x-gitlab-token'] || '';
    if (!crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(GITLAB_SECRET)
    )) {
      console.warn('[GitLab-Adapter] Webhook-Signatur ungültig — Payload ignoriert');
      return null;
    }
  }

  var event = headers['x-gitlab-event'] || '';
  var payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;

  if (event === 'Push Hook' || event === 'Tag Push Hook') {
    return ingestPush(payload);
  }
  if (event === 'Merge Request Hook') {
    return ingestMergeRequest(payload);
  }

  console.log('[GitLab-Adapter] Unbekanntes Event: ' + event + ' — ignoriert');
  return null;
}

function ingestPush(p) {
  if (!p.commits || p.commits.length === 0) return null;

  var latestCommit = p.commits[p.commits.length - 1];
  var repoName = p.project && p.project.path_with_namespace
    ? p.project.path_with_namespace.replace('/', '-')
    : (p.repository && p.repository.name) || 'unknown';

  return {
    domain:         'devops',
    source:         'git-webhook',
    adapter:        'gitlab-webhook',
    tenant_id:      process.env.MERIDIAN_DEFAULT_TENANT || 'default',
    title:          latestCommit.message ? latestCommit.message.split('\n')[0].slice(0, 120) : 'Git Push',
    description:    buildDescription(p),
    repo_name:      repoName,
    branch:         extractBranch(p.ref),
    commit_sha:     latestCommit.id || p.checkout_sha,
    additions:      sumAdds(p.commits),
    deletions:      sumDels(p.commits),
    external_ref:   latestCommit.url,
    external_data:  JSON.stringify({
      pusher:       p.user_name,
      commit_count: p.total_commits_count || p.commits.length,
      project_id:   p.project_id,
      gitlab_url:   GITLAB_URL,
    }),
  };
}

function ingestMergeRequest(p) {
  var mr  = p.object_attributes;
  var repo = p.project && p.project.path_with_namespace
    ? p.project.path_with_namespace.replace('/', '-')
    : 'unknown';

  // Nur bei Öffnen oder Aktualisieren relevant
  if (!['open', 'update', 'reopen'].includes(mr.action)) return null;

  return {
    domain:         'devops',
    source:         'git-webhook',
    adapter:        'gitlab-webhook',
    tenant_id:      process.env.MERIDIAN_DEFAULT_TENANT || 'default',
    title:          mr.title ? mr.title.slice(0, 120) : 'Merge Request',
    description:    mr.description || '',
    repo_name:      repo,
    branch:         mr.source_branch,
    commit_sha:     mr.last_commit && mr.last_commit.id,
    external_ref:   mr.url,
    change_type:    'code',
    external_data:  JSON.stringify({
      mr_id:        mr.iid,
      target_branch: mr.target_branch,
      author:       p.user && p.user.name,
      state:        mr.state,
      action:       mr.action,
    }),
  };
}

// ── Outbound: Status zurück an GitLab ─────────────────────────────

/**
 * notify(changeRecord, event) → Promise<{ok, externalId}>
 * Postet Commit-Status zurück an GitLab (Commit Status API).
 */
function notify(changeRecord, event) {
  if (!changeRecord.commit_sha || !changeRecord.repo_name) {
    return Promise.resolve({ ok: false, error: 'Kein commit_sha oder repo_name' });
  }

  var statusMap = {
    APPROVED:    { state: 'success',  description: 'Meridian: APPROVED' },
    BLOCKED:     { state: 'failed',   description: 'Meridian: BLOCKED — Review erforderlich' },
    OVERRIDDEN:  { state: 'success',  description: 'Meridian: OVERRIDDEN (Admin-Exception)' },
    PENDING:     { state: 'running',  description: 'Meridian: Analyse läuft...' },
  };

  var statusInfo = statusMap[changeRecord.status] || { state: 'pending', description: 'Meridian: ' + changeRecord.status };

  var projectPath = encodeURIComponent(changeRecord.repo_name.replace('-', '/'));
  var apiUrl = GITLAB_URL + '/api/v4/projects/' + projectPath + '/statuses/' + changeRecord.commit_sha;

  var body = JSON.stringify({
    state:       statusInfo.state,
    name:        'meridian/devops-gate',
    description: statusInfo.description,
    target_url:  (process.env.MERIDIAN_DASHBOARD_URL || 'http://localhost:3011')
                 + '/cra/rfc/' + changeRecord.id,
  });

  var token = process.env.MERIDIAN_GITLAB_API_TOKEN || '';
  if (!token) return Promise.resolve({ ok: false, error: 'MERIDIAN_GITLAB_API_TOKEN nicht gesetzt' });

  return new Promise(function(resolve) {
    var https = require('https');
    var http  = require('http');
    var parsed = require('url').parse(apiUrl);
    var lib = parsed.protocol === 'https:' ? https : http;

    var opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.path,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': token, 'Content-Length': Buffer.byteLength(body) },
    };

    var req = lib.request(opts, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve({ ok: true, externalId: JSON.parse(data).id }); }
          catch(e) { resolve({ ok: true }); }
        } else {
          console.error('[GitLab-Adapter] Status-Post Fehler ' + res.statusCode + ': ' + data.slice(0, 200));
          resolve({ ok: false, status: res.statusCode });
        }
      });
    });
    req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
    req.write(body);
    req.end();
  });
}

/**
 * health() → Promise<{ok, latencyMs, version}>
 */
function health() {
  var start = Date.now();
  var token = process.env.MERIDIAN_GITLAB_API_TOKEN || '';
  if (!token) return Promise.resolve({ ok: false, error: 'MERIDIAN_GITLAB_API_TOKEN nicht konfiguriert' });

  return new Promise(function(resolve) {
    var https = require('https');
    var http  = require('http');
    var parsed = require('url').parse(GITLAB_URL + '/api/v4/version');
    var lib = parsed.protocol === 'https:' ? https : http;

    var req = lib.get({ hostname: parsed.hostname, port: parsed.port, path: parsed.path,
      headers: { 'PRIVATE-TOKEN': token } }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          resolve({ ok: res.statusCode === 200, latencyMs: Date.now() - start, version: json.version });
        } catch(e) {
          resolve({ ok: false, latencyMs: Date.now() - start });
        }
      });
    });
    req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
    req.setTimeout(5000, function() { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
  });
}

/**
 * validateConfig(config) → {valid, errors[]}
 */
function validateConfig(config) {
  var errors = [];
  if (!config.gitlab_url && !process.env.MERIDIAN_GITLAB_URL) {
    errors.push('gitlab_url oder MERIDIAN_GITLAB_URL fehlt');
  }
  return { valid: errors.length === 0, errors: errors };
}

// ── Hilfsfunktionen ────────────────────────────────────────────────

function extractBranch(ref) {
  if (!ref) return '';
  return ref.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, 'tag/');
}

function buildDescription(p) {
  var lines = [];
  if (p.user_name)        lines.push('Pusher: ' + p.user_name);
  if (p.total_commits_count) lines.push('Commits: ' + p.total_commits_count);
  if (p.commits && p.commits.length > 0) {
    lines.push('');
    p.commits.slice(-3).forEach(function(c) {
      lines.push('- ' + (c.message || '').split('\n')[0].slice(0, 80));
    });
  }
  return lines.join('\n');
}

function sumAdds(commits) {
  return commits.reduce(function(s, c) {
    return s + ((c.added && c.added.length) || 0) + ((c.modified && c.modified.length) || 0);
  }, 0);
}

function sumDels(commits) {
  return commits.reduce(function(s, c) {
    return s + ((c.removed && c.removed.length) || 0);
  }, 0);
}

module.exports = { ingest: ingest, notify: notify, health: health, validateConfig: validateConfig };
