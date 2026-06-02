// SPDX-License-Identifier: Apache-2.0
// kis-context.js — KIS semantic context fetch for CRA review enrichment
// Calls an internal KB endpoint, returns a prompt block (or '' on failure).
// All errors are graceful — CRA review continues without context if KIS unavailable.

var http = require('http');
var https = require('https');
var urlParse = require('url').parse;

var KIS_URL = process.env.KIS_INTERNAL_URL || '';
var KIS_TOKEN = process.env.MERIDIAN_KB_TOKEN || '';
var TIMEOUT_MS = 6000;

function fetchKisContext(queryText, callback) {
  var empty = { kbArticles: [], adrs: [], runbooks: [], rfcs: [] };
  if (!KIS_URL || !KIS_TOKEN) return callback(null, empty);

  var encoded = encodeURIComponent(String(queryText || '').substring(0, 400));
  var urlStr = KIS_URL.replace(/\/$/, '') + '/api/v1/internal/kb/semantic?q=' + encoded + '&n=3';
  var parsed = urlParse(urlStr);
  var lib = parsed.protocol === 'https:' ? https : http;

  var opts = {
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.path,
    method: 'GET',
    headers: { 'x-internal-token': KIS_TOKEN },
    timeout: TIMEOUT_MS,
  };

  var req = lib.request(opts, function(res) {
    var body = '';
    res.on('data', function(c) { body += c; });
    res.on('end', function() {
      try {
        var data = JSON.parse(body);
        callback(null, {
          kbArticles: data.kbArticles || [],
          adrs: data.adrs || [],
          runbooks: data.runbooks || [],
          rfcs: data.rfcs || [],
        });
      } catch (e) {
        console.warn('[KIS] Parse-Fehler:', e.message);
        callback(null, empty);
      }
    });
  });
  req.on('error', function(e) {
    console.warn('[KIS] Nicht erreichbar:', e.message);
    callback(null, empty);
  });
  req.on('timeout', function() {
    req.destroy();
    console.warn('[KIS] Timeout nach ' + TIMEOUT_MS + 'ms');
    callback(null, empty);
  });
  req.end();
}

function buildKisBlock(kis) {
  var parts = [];

  if (kis.kbArticles && kis.kbArticles.length > 0) {
    parts.push('Relevante KB-Artikel:');
    kis.kbArticles.forEach(function(a) {
      var title = (a.metadata && a.metadata.title) || (a.text || '').substring(0, 80);
      parts.push('  - ' + title);
    });
  }
  if (kis.adrs && kis.adrs.length > 0) {
    parts.push('Relevante ADRs:');
    kis.adrs.forEach(function(a) {
      var title = (a.metadata && a.metadata.title) || (a.text || '').substring(0, 80);
      var num = a.metadata && a.metadata.number ? ' (ADR-' + a.metadata.number + ')' : '';
      parts.push('  - ' + title + num);
    });
  }
  if (kis.runbooks && kis.runbooks.length > 0) {
    parts.push('Verwandte Runbooks:');
    kis.runbooks.forEach(function(r) {
      var title = (r.metadata && r.metadata.title) || (r.text || '').substring(0, 80);
      parts.push('  - ' + title);
    });
  }
  if (kis.rfcs && kis.rfcs.length > 0) {
    parts.push('Aehnliche CRA-Findings (Historie):');
    kis.rfcs.forEach(function(r) {
      var title = (r.metadata && r.metadata.title) || (r.text || '').substring(0, 80);
      var id = r.metadata && r.metadata.rfc_id ? ' [' + r.metadata.rfc_id + ']' : '';
      var status = r.metadata && r.metadata.status ? ' → ' + r.metadata.status : '';
      parts.push('  - ' + title + id + status);
    });
  }

  if (parts.length === 0) return '';
  var block = '\n## Wissenskontext (KIS)\n' + parts.join('\n');
  return block.length > 1200 ? block.substring(0, 1197) + '...' : block;
}

module.exports = { fetchKisContext: fetchKisContext, buildKisBlock: buildKisBlock };
