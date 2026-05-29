#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// meridian/server.js — Meridian OSS-Core Entrypoint (Container-Default)
//
// Bewusst getrennt vom privaten Ops-Dashboard. Dieser Entrypoint enthaelt KEINE
// betreiber-spezifischen Altlasten:
//   • kein require eines externen SSO-Moduls  → loest Boot-Crash B/#1
//   • kein ADMIN_USER/ADMIN_PASS process.exit → loest Boot-Crash B/#2
//   • keine betreiber-spezifischen Crons / Shell-/SSH-Calls → #4
//
// Er mountet ausschliesslich die generische CRA-API, die /api/cra/health
// bedient — exakt der Pfad, den der Dockerfile-HEALTHCHECK und docker-compose
// pruefen.
//
// Auth: MERIDIAN_AUTH_ENABLED=1 erzwingt Token (X-CRA-Token: CRA_API_TOKEN).
//       Default (Dev/Boot) = offen, damit der HEALTHCHECK ohne Credentials 200 bekommt.
//
// Start:  node meridian/server.js     (Container: CMD ["node","meridian/server.js"])

'use strict';

var http = require('http');
var cra = require('./core/cra-api');

var PORT = parseInt(process.env.PORT, 10) || 3011;
var AUTH_ENABLED = process.env.MERIDIAN_AUTH_ENABLED === '1' || process.env.MERIDIAN_AUTH_ENABLED === 'true';
var MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || '10485760', 10);

// ── Helper (kompatibel mit der craApi(req,res,url,{json,authed,body})-Schnittstelle) ──

function json(res, d, status, extraHeaders) {
  if (res.writableEnded) return;
  var h = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
  res.writeHead(status || 200, h);
  res.end(JSON.stringify(d));
}

// Im Dev-/Boot-Modus (AUTH_ENABLED=false) gilt jeder Request als authentifiziert,
// damit der unauthentifizierte HEALTHCHECK ein 200 bekommt. Mit AUTH_ENABLED greift
// stattdessen die Token-Pruefung in cra-api (tokenAuth via X-CRA-Token).
function authed(req) {
  return !AUTH_ENABLED;
}

function body(req) {
  return new Promise(function(ok) {
    var b = '';
    var size = 0;
    var aborted = false;
    req.on('data', function(c) {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        req.destroy();
        return ok('');
      }
      b += c;
    });
    req.on('end', function() { if (!aborted) ok(b); });
    req.on('error', function() { if (!aborted) ok(''); });
  });
}

// ── Routing ────────────────────────────────────────────────────────

var server = http.createServer(function(req, res) {
  var url = (req.url || '').split('?')[0];

  // Container-natives Liveness-Signal (ohne DB-Abhaengigkeit).
  if (url === '/health') {
    return json(res, { status: 'ok', service: 'meridian-core', uptime: process.uptime() | 0, pid: process.pid });
  }

  // Generische CRA-API inkl. /api/cra/health (HEALTHCHECK-Ziel).
  if (url.indexOf('/api/cra/') === 0) {
    var boundBody = function(r) { return body(r); };
    return cra.craApi(req, res, url, { json: json, authed: authed, body: boundBody });
  }

  json(res, { error: 'Not Found', service: 'meridian-core' }, 404);
});

// ── Boot: DB initialisieren (Schema via CREATE TABLE IF NOT EXISTS), dann listen ──

cra.initCra().then(function() {
  server.listen(PORT, function() {
    console.log('[meridian] Core listening on port ' + PORT +
      ' (auth=' + (AUTH_ENABLED ? 'enforced' : 'open/dev') + ', db=' + (process.env.DB_PATH || 'default') + ')');
  });
}).catch(function(e) {
  console.error('[meridian] FATAL: Init fehlgeschlagen:', e && e.message);
  process.exit(1);
});

// Graceful shutdown (tini liefert SIGTERM als PID-1-Reaper).
function shutdown(sig) {
  console.log('[meridian] ' + sig + ' empfangen — fahre herunter.');
  server.close(function() { process.exit(0); });
  setTimeout(function() { process.exit(0); }, 5000).unref();
}
process.on('SIGTERM', function() { shutdown('SIGTERM'); });
process.on('SIGINT', function() { shutdown('SIGINT'); });
