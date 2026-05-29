// SPDX-License-Identifier: Apache-2.0
// meridian/lib/llm.js — LLM-Abstraktion für den CRA-Core.
//
// Callback-Interface (drop-in kompatibel mit dem bisherigen opsdesk-llm):
//   ask(prompt, opts, cb)        → cb(text|null)
//   askGroq(prompt, opts, cb)    → cb(text|null)   (Provider-Hint; Router entscheidet real)
//   askGemini(prompt, opts, cb)  → cb(text|null)
//   parallel(stages, cb)         → cb({ label: text|null, ... })
//   getStats()                   → Objekt mit Zählern
//
// opts: { maxTokens, temperature, webSearch } (webSearch wird vom OSS-Router ignoriert).
//
// Zwei Modi:
//   1) MERIDIAN_LLM_ADAPTER = Modulpfad → ALLE Aufrufe werden an dieses Modul
//      delegiert. So bindet CRA Plus seinen bestehenden Groq/Gemini-Router an,
//      ohne dass der Core admin/opsdesk kennt (OSS bleibt self-contained).
//   2) sonst eingebauter Tier-Router: Ollama → DeepSeek → Anthropic (per .env).
//      Ohne konfigurierte Keys: cb(null) (graceful, wie der bisherige Fallback).
'use strict';

var http = require('http');
var https = require('https');

var stats = {
  anthropic: { calls: 0, errors: 0 },
  deepseek:  { calls: 0, errors: 0 },
  ollama:    { calls: 0, errors: 0 },
  fallback: 0,
  adapter: 0
};

// ── Optionaler Adapter (CRA Plus / Custom) ─────────────────────────
var adapter = null;
if (process.env.MERIDIAN_LLM_ADAPTER) {
  try {
    adapter = require(process.env.MERIDIAN_LLM_ADAPTER);
  } catch (e) {
    console.error('[meridian/llm] Adapter nicht ladbar (' + process.env.MERIDIAN_LLM_ADAPTER + '):', e.message);
  }
}

// ── HTTP-Helfer (dependency-frei) ──────────────────────────────────
function postJson(urlStr, headers, bodyObj, cb) {
  var u;
  try { u = new URL(urlStr); } catch (e) { return cb(e); }
  var lib = u.protocol === 'http:' ? http : https;
  var data = JSON.stringify(bodyObj);
  var req = lib.request({
    method: 'POST',
    hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: u.pathname + u.search,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers)
  }, function(res) {
    var buf = '';
    res.on('data', function(c) { buf += c; });
    res.on('end', function() {
      if (res.statusCode < 200 || res.statusCode >= 300) return cb(new Error('HTTP ' + res.statusCode + ': ' + buf.slice(0, 200)));
      try { cb(null, JSON.parse(buf)); } catch (e) { cb(e); }
    });
  });
  req.on('error', cb);
  req.setTimeout(60000, function() { req.destroy(new Error('LLM-Timeout')); });
  req.end(data);
}

// ── Provider ───────────────────────────────────────────────────────
function anthropicCall(prompt, opts, cb) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return cb(null);
  // Claude-4-IDs sind NICHT datiert (siehe Doku); Haiku als günstiger Default.
  var model = process.env.MERIDIAN_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  postJson('https://api.anthropic.com/v1/messages',
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { model: model, max_tokens: opts.maxTokens || 512, temperature: opts.temperature != null ? opts.temperature : 0.2,
      messages: [{ role: 'user', content: prompt }] },
    function(err, json) {
      if (err) { stats.anthropic.errors++; return cb(null); }
      stats.anthropic.calls++;
      var text = json && json.content && json.content[0] && json.content[0].text;
      cb(text || null);
    });
}

function deepseekCall(prompt, opts, cb) {
  var key = process.env.DEEPSEEK_API_KEY;
  if (!key) return cb(null);
  postJson('https://api.deepseek.com/chat/completions',
    { 'Authorization': 'Bearer ' + key },
    { model: process.env.MERIDIAN_DEEPSEEK_MODEL || 'deepseek-chat', max_tokens: opts.maxTokens || 512,
      temperature: opts.temperature != null ? opts.temperature : 0.2,
      messages: [{ role: 'user', content: prompt }] },
    function(err, json) {
      if (err) { stats.deepseek.errors++; return cb(null); }
      stats.deepseek.calls++;
      var text = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      cb(text || null);
    });
}

function ollamaCall(prompt, opts, cb) {
  var base = process.env.OLLAMA_BASE_URL;
  if (!base) return cb(null);
  postJson(base.replace(/\/$/, '') + '/api/generate',
    {},
    { model: process.env.MERIDIAN_OLLAMA_MODEL || 'qwen2.5-coder', prompt: prompt, stream: false,
      options: { temperature: opts.temperature != null ? opts.temperature : 0.2, num_predict: opts.maxTokens || 512 } },
    function(err, json) {
      if (err) { stats.ollama.errors++; return cb(null); }
      stats.ollama.calls++;
      cb((json && json.response) || null);
    });
}

// ── Tier-Router: lokal → DeepSeek → Anthropic ──────────────────────
function route(prompt, opts, cb) {
  opts = opts || {};
  if (process.env.OLLAMA_BASE_URL) {
    return ollamaCall(prompt, opts, function(t) { if (t) return cb(t); next(); });
  }
  next();
  function next() {
    if (process.env.DEEPSEEK_API_KEY) {
      return deepseekCall(prompt, opts, function(t) { if (t) return cb(t); last(); });
    }
    last();
  }
  function last() {
    if (process.env.ANTHROPIC_API_KEY) return anthropicCall(prompt, opts, cb);
    stats.fallback++;
    cb(null);
  }
}

// ── Öffentliches Interface ─────────────────────────────────────────
function ask(prompt, opts, cb) {
  if (adapter && adapter.ask) { stats.adapter++; return adapter.ask(prompt, opts, cb); }
  route(prompt, opts || {}, cb);
}
function askGroq(prompt, opts, cb) {
  if (adapter && adapter.askGroq) { stats.adapter++; return adapter.askGroq(prompt, opts, cb); }
  route(prompt, opts || {}, cb);
}
function askGemini(prompt, opts, cb) {
  if (adapter && adapter.askGemini) { stats.adapter++; return adapter.askGemini(prompt, opts, cb); }
  route(prompt, opts || {}, cb);
}

function parallel(stages, cb) {
  if (adapter && adapter.parallel) { stats.adapter++; return adapter.parallel(stages, cb); }
  var results = {};
  var pending = stages.length;
  if (pending === 0) return cb(results);
  stages.forEach(function(stage) {
    var label = stage.label || 'stage';
    route(stage.prompt, { maxTokens: stage.maxTokens || 512, temperature: stage.temperature != null ? stage.temperature : 0.2 },
      function(text) {
        results[label] = text || null;
        if (--pending === 0) cb(results);
      });
  });
}

function getStats() {
  if (adapter && adapter.getStats) {
    try { return Object.assign({ adapterCalls: stats.adapter }, adapter.getStats()); } catch (e) { /* fallthrough */ }
  }
  return JSON.parse(JSON.stringify(stats));
}

module.exports = { ask: ask, askGroq: askGroq, askGemini: askGemini, parallel: parallel, getStats: getStats };
