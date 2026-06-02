// SPDX-License-Identifier: Apache-2.0
// admin/cra/tool-findings-classifier.js — Phase 1.2 (CRA-Strategie 2026-04-25)
// 2026-04-29: Qwen-Pre-Filter durch DeepSeek V4-Flash ersetzt (Mac-Ollama-LaunchAgents
// wurden mit Pipeline-Switch deaktiviert; siehe docs/llm-pipeline-runbook.md).
//
// Klassifiziert offene tool_findings (ai_severity IS NULL) in 2 Stufen:
//
//   1. DeepSeek V4-Flash Pre-Filter via api.deepseek.com (Cloud, ~$0.001/Batch)
//      → Output: { severity, confidence, reason, suggested_fix }
//      → confidence ≥ 0.8 UND tool_severity < HIGH → final übernommen
//   2. Haiku 4.5 Eskalation für ambiguous (confidence < 0.8) ODER tool_severity ≥ HIGH
//      → präzisere Klassifikation, bezahlt aber genauer
//
// Nichts überschreibt Status 'ignored' / 'resolved' (nur ai_severity IS NULL).
// Audit-Trail in hook_events nach jedem Batch.

var craDb = require('./cra-db');
var https = require('https');

var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
var HAIKU_MODEL = 'claude-haiku-4-5-20251001';
var BATCH_SIZE = 10;
var DEEPSEEK_TIMEOUT_MS = 60000;

// ── Prompts ────────────────────────────────────────────────────────────────
var SYSTEM_PROMPT = 'Du bist ein Code-Security Severity-Classifier fuer Linter/SAST Tool-Outputs.\n' +
'Klassifiziere jedes Finding nach realer Bedeutung (nicht was das Tool labelt).\n\n' +
'Severity-Kategorien:\n' +
'- CRITICAL: Security-Vulnerability mit aktivem Exploit-Risk (RCE, SQL-Injection, Auth-Bypass, Secrets in Code, exponiertes PII)\n' +
'- HIGH: Logic-Bug mit Daten-Risiko, Performance-Killer in Request-Path, Race-Condition\n' +
'- MEDIUM: Code-Smell mit Maintainability-Impact, deprecated APIs, schwache Validierung\n' +
'- LOW: Stilistische Issues mit Auswirkung (komplexe Funktion, lange Datei)\n' +
'- IGNORE: False-Positive, auto-fixable Stil-Issues (Semicolons, Spacing), Test-Code-Findings ohne Impact\n\n' +
'Antworte AUSSCHLIESSLICH mit valid JSON-Array, ein Objekt pro Finding (gleiche Reihenfolge):\n' +
'[{"id": <id>, "severity": "...", "confidence": 0.0-1.0, "reason": "kurz", "suggested_fix": "1 Satz | null"}]';

function buildClassificationPrompt(findings) {
  var lines = findings.map(function(f, i) {
    return '#' + f.id + ' [' + f.tool + '/' + (f.tool_severity || '?') + '] ' +
           f.rule_id + ' @ ' + f.file_path + ':' + f.line_no + ' — ' +
           (f.message || '').replace(/\n/g, ' ').substring(0, 200);
  });
  return 'Findings:\n' + lines.join('\n') + '\n\nGib JSON-Array mit ' + findings.length + ' Eintraegen zurueck.';
}

// ── DeepSeek V4-Flash Pre-Filter ───────────────────────────────────────────
// JSON-Mode garantiert struktur, System-Prompt-Cache spart Cost ab 2. Call.
function classifyBatchDeepSeek(findings) {
  var userPrompt = buildClassificationPrompt(findings);
  return new Promise(function(resolve) {
    var apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return resolve({ ok: false, error: 'DEEPSEEK_API_KEY nicht gesetzt' });
    // DeepSeek JSON-Mode liefert ein Object — wir wrapen unser Array darin als {"items":[...]}
    var systemForJsonMode = SYSTEM_PROMPT.replace(
      'valid JSON-Array, ein Objekt pro Finding',
      'valid JSON-Object {"items":[...]} mit ein Objekt pro Finding'
    );
    var payload = JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemForJsonMode },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 2048
    });
    var opts = {
      hostname: 'api.deepseek.com', port: 443,
      path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: DEEPSEEK_TIMEOUT_MS
    };
    var req = https.request(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try {
          var d = JSON.parse(body);
          if (res.statusCode !== 200 || d.error) {
            return resolve({ ok: false, error: 'HTTP ' + res.statusCode + ': ' + (d.error && d.error.message || body.substring(0, 200)) });
          }
          var msg = d.choices && d.choices[0] && d.choices[0].message;
          var text = msg ? msg.content : '';
          // JSON-Mode liefert Object — extrahiere "items" Array
          var parsed = JSON.parse(text);
          var arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : null);
          if (!arr) return resolve({ ok: false, error: 'JSON-Mode-Response ohne items-Array' });
          var u = d.usage || {};
          // Cost-Tracking
          try {
            var nonCached = Math.max(0, (u.prompt_tokens || 0) - (u.prompt_cache_hit_tokens || 0));
            var cost = nonCached / 1e6 * 0.14 + (u.prompt_cache_hit_tokens || 0) / 1e6 * 0.0028 + (u.completion_tokens || 0) / 1e6 * 0.28;
            craDb.run(
              "INSERT INTO cra_llm_usage (provider, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, context) VALUES (?,?,?,?,?,?,?)",
              ['deepseek', 'deepseek-chat', u.prompt_tokens || 0, u.completion_tokens || 0, u.prompt_cache_hit_tokens || 0, cost, 'tool-findings-classifier']
            );
          } catch (e) { /* swallow — usage-table optional */ }
          resolve({ ok: true, classifications: arr, source: 'deepseek', tokens_in: u.prompt_tokens || 0, tokens_out: u.completion_tokens || 0 });
        } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
      });
    });
    req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
    req.on('timeout', function() { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload); req.end();
  });
}

// ── Haiku Eskalation ───────────────────────────────────────────────────────
function callAnthropic(prompt) {
  return new Promise(function(resolve) {
    if (!ANTHROPIC_API_KEY) return resolve({ ok: false, error: 'ANTHROPIC_API_KEY nicht gesetzt' });
    var payload = JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 4096,
      temperature: 0.1,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }]
    });
    var opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      },
      timeout: 60000
    };
    var req = https.request(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try {
          var parsed = JSON.parse(body);
          if (res.statusCode !== 200) return resolve({ ok: false, error: 'HTTP ' + res.statusCode + ': ' + (parsed.error && parsed.error.message || body.substring(0, 200)) });
          var text = (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
          resolve({ ok: true, text: text, usage: parsed.usage });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
    req.on('timeout', function() { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

async function classifyBatchHaiku(findings) {
  var prompt = buildClassificationPrompt(findings);
  var res = await callAnthropic(prompt);
  if (!res.ok) return { ok: false, error: res.error };
  var jsonMatch = res.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return { ok: false, error: 'kein JSON-Array in Haiku-Output' };
  try {
    var parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return { ok: false, error: 'parsed ist kein Array' };
    return { ok: true, classifications: parsed, source: 'haiku', usage: res.usage };
  } catch (e) {
    return { ok: false, error: 'JSON-Parse: ' + e.message };
  }
}

// ── Anwenden auf DB ────────────────────────────────────────────────────────
function applyClassifications(classifications, source, originalFindings) {
  var byId = {};
  classifications.forEach(function(c) { if (c.id != null) byId[c.id] = c; });
  var applied = 0;
  originalFindings.forEach(function(f) {
    var c = byId[f.id];
    if (!c) return;
    var sev = String(c.severity || '').toUpperCase();
    if (['CRITICAL','HIGH','MEDIUM','LOW','IGNORE'].indexOf(sev) === -1) return;
    var conf = parseFloat(c.confidence);
    if (!isFinite(conf)) conf = 0.5;
    var newStatus = sev === 'IGNORE' ? 'ignored' : 'classified';
    craDb.run(
      `UPDATE tool_findings
         SET ai_severity = ?, ai_confidence = ?, ai_reason = ?, ai_suggested_fix = ?,
             classified_by = ?, classified_at = datetime('now','localtime'), status = ?
       WHERE id = ?`,
      [sev, conf, String(c.reason || '').substring(0, 500),
       c.suggested_fix ? String(c.suggested_fix).substring(0, 500) : null,
       source, newStatus, f.id]
    );
    applied++;
  });
  return applied;
}

// ── Haupt-Loop ─────────────────────────────────────────────────────────────
async function classifyOpenFindings(opts) {
  var maxBatches = (opts && opts.maxBatches) || 5; // pro Run cap
  var totalApplied = 0;
  var totalEscalated = 0;
  var batches = 0;
  var errors = [];

  while (batches < maxBatches) {
    var open = craDb.all(
      `SELECT id, tool, rule_id, file_path, line_no, tool_severity, message
         FROM tool_findings
         WHERE ai_severity IS NULL AND status = 'open'
         ORDER BY id ASC LIMIT ?`,
      [BATCH_SIZE]
    );
    if (!open.length) break;
    batches++;

    // 1. DeepSeek V4-Flash Pre-Filter
    var dsRes = await classifyBatchDeepSeek(open);
    var dsIds = {};
    var needsHaiku = open.slice();
    if (dsRes.ok && Array.isArray(dsRes.classifications)) {
      // Nur Findings uebernehmen die: confidence >= 0.8 UND tool_severity < HIGH
      var firmClassifications = [];
      dsRes.classifications.forEach(function(c) {
        var orig = open.find(function(o) { return o.id === c.id; });
        if (!orig) return;
        var conf = parseFloat(c.confidence) || 0;
        var toolSev = (orig.tool_severity || '').toUpperCase();
        var isCriticalTool = toolSev === 'CRITICAL' || toolSev === 'HIGH';
        if (conf >= 0.8 && !isCriticalTool) {
          firmClassifications.push(c);
          dsIds[c.id] = true;
        }
      });
      if (firmClassifications.length) {
        var firmFindings = open.filter(function(o) { return dsIds[o.id]; });
        totalApplied += applyClassifications(firmClassifications, 'deepseek', firmFindings);
      }
      needsHaiku = open.filter(function(o) { return !dsIds[o.id]; });
    } else if (dsRes.error) {
      errors.push('deepseek-batch: ' + dsRes.error);
    }

    // 2. Haiku Eskalation fuer Rest
    if (needsHaiku.length) {
      var hRes = await classifyBatchHaiku(needsHaiku);
      if (hRes.ok && Array.isArray(hRes.classifications)) {
        totalApplied += applyClassifications(hRes.classifications, 'haiku', needsHaiku);
        totalEscalated += needsHaiku.length;
      } else {
        errors.push('haiku-batch: ' + hRes.error);
        // Failed Findings bleiben open — werden im nächsten Run nochmal probiert
      }
    }
  }

  try { craDb.saveCraDb(); } catch (e) {}
  // Audit
  try {
    craDb.run(
      'INSERT INTO hook_events (hook_name, event_type, repo_name, details) VALUES (?,?,?,?)',
      ['tool-findings-classifier', 'classify-batch', '_system_',
       'batches=' + batches + ' applied=' + totalApplied + ' haiku=' + totalEscalated +
       (errors.length ? ' errors=' + errors.length + ' first=' + errors[0].substring(0, 150) : '')]
    );
    craDb.saveCraDb();
  } catch (e) {}

  return {
    ok: errors.length === 0 || totalApplied > 0,
    batches: batches,
    applied: totalApplied,
    haiku_escalated: totalEscalated,
    errors: errors
  };
}

module.exports = {
  classifyOpenFindings: classifyOpenFindings,
  // Exports fuer Tests / direkte Nutzung
  classifyBatchDeepSeek: classifyBatchDeepSeek,
  classifyBatchHaiku: classifyBatchHaiku
};
