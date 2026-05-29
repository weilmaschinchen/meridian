// admin/cra/minio-uploader.js — Minimal S3 PUT for CRA reports (no deps)
'use strict';
var crypto = require('crypto');
var http = require('http');

var ENDPOINT = process.env.CRA_MINIO_ENDPOINT || 'localhost';
var PORT = parseInt(process.env.CRA_MINIO_PORT || '9000', 10);
var ACCESS_KEY = process.env.CRA_MINIO_ACCESS_KEY || 'cra-writer';
var SECRET_KEY = process.env.CRA_MINIO_SECRET_KEY || '';
var BUCKET = process.env.CRA_MINIO_BUCKET || 'cra-reports';
var ENABLED = process.env.CRA_MINIO_ENABLED !== '0';

function hmac(key, data, enc) {
  return crypto.createHmac('sha256', key).update(data).digest(enc || undefined);
}
function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) {
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
}
function fmtDateTime(d) {
  return fmtDate(d) + 'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
}

function putObject(key, body) {
  return new Promise(function(resolve) {
    if (!SECRET_KEY) { resolve({ ok: false, reason: 'no-secret-key' }); return; }
    var buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    var now = new Date();
    var dateStamp = fmtDate(now);
    var amzDate = fmtDateTime(now);
    var host = ENDPOINT + ':' + PORT;
    var path = '/' + BUCKET + '/' + key;
    var contentType = 'application/json';
    var payloadHash = sha256hex(buf);

    var canonHeaders = 'content-type:' + contentType + '\n' +
      'host:' + host + '\n' +
      'x-amz-content-sha256:' + payloadHash + '\n' +
      'x-amz-date:' + amzDate + '\n';
    var signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    var credScope = dateStamp + '/us-east-1/s3/aws4_request';
    var canonReq = ['PUT', path, '', canonHeaders, signedHeaders, payloadHash].join('\n');
    var strToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, sha256hex(canonReq)].join('\n');
    var sigKey = hmac(hmac(hmac(hmac('AWS4' + SECRET_KEY, dateStamp), 'us-east-1'), 's3'), 'aws4_request');
    var sig = hmac(sigKey, strToSign, 'hex');
    var auth = 'AWS4-HMAC-SHA256 Credential=' + ACCESS_KEY + '/' + credScope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + sig;

    var req = http.request({
      hostname: ENDPOINT, port: PORT, path: path, method: 'PUT',
      headers: {
        'Content-Type': contentType, 'Content-Length': buf.length,
        'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
        'Authorization': auth
      }
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) console.warn('[CRA/MinIO] PUT', key, 'HTTP', res.statusCode, Buffer.concat(chunks).toString('utf8').substring(0, 200));
        resolve({ ok: ok, statusCode: res.statusCode, key: key });
      });
    });
    req.on('error', function(e) {
      console.warn('[CRA/MinIO] Netzfehler:', e.message);
      resolve({ ok: false, error: e.message });
    });
    req.setTimeout(5000, function() { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.write(buf);
    req.end();
  });
}

// Fire-and-forget: catch wird intern behandelt, kein throw nach außen
function uploadReport(rfcId, repoName, data) {
  if (!ENABLED) return;
  var d = new Date();
  var key = d.getUTCFullYear() + '/' +
    pad2(d.getUTCMonth() + 1) + '/' +
    pad2(d.getUTCDate()) + '/' +
    (repoName || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '-') + '/' +
    rfcId + '.json';
  putObject(key, data).then(function(r) {
    if (r.ok) console.log('[CRA/MinIO] Report gespeichert:', key);
  }).catch(function() {});
}

module.exports = { uploadReport: uploadReport };
