// admin/cra/github-diff.js — Diff via GitHub API holen (Fallback fuer Repos ohne lokalen Mirror)
// Benoetigt Token mit Scope: Contents:read.
var https = require('https');

var TOKEN = process.env.GITHUB_CRA_TOKEN || '';
var MAX_FILES = 300;
var MAX_DIFF_SIZE = 5 * 1024 * 1024;

function httpGet(path) {
  return new Promise(function(resolve, reject) {
    if (!TOKEN) return reject(new Error('no-token'));
    var req = https.request({
      hostname: 'api.github.com',
      path: path,
      method: 'GET',
      headers: {
        'Authorization': 'token ' + TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'cra-diff-fetcher'
      },
      timeout: 15000
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('json-parse: ' + e.message)); }
        } else {
          reject(new Error('http ' + res.statusCode + ': ' + body.substring(0, 150)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// GitHub Files-Array (von /commits/:sha oder /compare) → unified diff string
function buildUnifiedDiff(files) {
  files = files || [];
  if (files.length > MAX_FILES) {
    console.warn('[CRA/GitHubDiff] Zu viele Files:', files.length, '> limit', MAX_FILES, '— truncated');
    files = files.slice(0, MAX_FILES);
  }

  var parts = [];
  var totalSize = 0;

  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var filename = f.filename || '';
    var prevName = f.previous_filename || filename;
    var patch = f.patch || '';
    var section = 'diff --git a/' + prevName + ' b/' + filename + '\n';

    switch (f.status) {
      case 'added':
        section += 'new file mode 100644\n--- /dev/null\n+++ b/' + filename + '\n';
        break;
      case 'removed':
        section += 'deleted file mode 100644\n--- a/' + filename + '\n+++ /dev/null\n';
        break;
      case 'renamed':
        section += 'similarity index 90%\nrename from ' + prevName + '\nrename to ' + filename + '\n--- a/' + prevName + '\n+++ b/' + filename + '\n';
        break;
      default:
        section += '--- a/' + filename + '\n+++ b/' + filename + '\n';
    }

    if (patch) section += patch + '\n';

    totalSize += section.length;
    if (totalSize > MAX_DIFF_SIZE) {
      console.warn('[CRA/GitHubDiff] Diff > 5MB bei file', i, '/', files.length, '— abgebrochen');
      break;
    }
    parts.push(section);
  }

  return parts.join('');
}

// Holt Diff eines einzelnen Commits (parent..head). Nutzt /repos/:repo/commits/:sha.
// Aequivalent zu `git diff <sha>~1 <sha>` auf lokalem Mirror.
function getCommitDiff(opts) {
  var repoFullName = opts.repoFullName;
  var sha = opts.sha;
  if (!repoFullName || !sha) return Promise.reject(new Error('incomplete'));

  return httpGet('/repos/' + repoFullName + '/commits/' + sha).then(function(data) {
    return {
      diff: buildUnifiedDiff(data.files),
      filesChanged: (data.files || []).length,
      sha: data.sha,
      message: (data.commit && data.commit.message) || '',
      parents: (data.parents || []).map(function(p) { return p.sha; })
    };
  });
}

// Holt Diff zwischen zwei SHAs (fuer Branch-Push mit mehreren Commits).
// Fallback wenn GitHub Compare > 300 files hat (dann nur Head-Commit).
function getCompareDiff(opts) {
  var repoFullName = opts.repoFullName;
  var base = opts.base;
  var head = opts.head;
  if (!repoFullName || !base || !head) return Promise.reject(new Error('incomplete'));

  // Zero-SHA (neuer Branch/force-push): nur letzten Commit analysieren
  if (/^0+$/.test(base)) {
    return getCommitDiff({ repoFullName: repoFullName, sha: head });
  }

  return httpGet('/repos/' + repoFullName + '/compare/' + base + '...' + head).then(function(data) {
    return {
      diff: buildUnifiedDiff(data.files),
      filesChanged: (data.files || []).length,
      aheadBy: data.ahead_by || 0,
      behindBy: data.behind_by || 0
    };
  });
}

module.exports = { getCommitDiff, getCompareDiff, buildUnifiedDiff };
