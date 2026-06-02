// SPDX-License-Identifier: Apache-2.0
// admin/cra/rfc-llm-review.js — Phase 2.1 (CRA-Strategie 2026-04-25)
//
// Zweiter Bewertungs-Pass pro RFC nach regel-basierter Analyse.
// Verhindert "Stempel-Approver"-Bug (19.04.): RFCs mit Score <20 wurden blind
// APPROVED, auch wenn CRITICAL-relevante Aenderungen drin waren.
//
// Routing:
// - Diff < 500 Zeilen UND Score < 10 UND keine HIGH-Findings: Qwen-Pass (kostenlos)
// - Diff >= 500 Zeilen ODER Score >= 10 ODER mind. 1 Finding HIGH/CRITICAL: Haiku-Pass (genauer)
// - Bei Qwen confidence < 0.7 → escalate zu Haiku
//
// Output: { status: 'agree'|'disagree', severity: 'CRITICAL'|...|'IGNORE', concerns: string }
// 'disagree' setzt KEIN Block — nur informativ im Report. Block bleibt regel-basiert.

var craDb = require('./cra-db');
var https = require('https');
var http = require('http');

var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
var HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Direct-Ollama (Phase 4 Bug-Fix 2026-04-27):
// prep-Worker verlangt ```diff-Block — unser JSON-Output failed dort.
// Direct-Call zu Tailscale-Mac umgeht das Format-Constraint.
var OLLAMA_HOST = process.env.OLLAMA_HOST_DIRECT || '100.109.108.63:11434';
var QWEN_DIRECT_MODEL = process.env.QWEN_DIRECT_MODEL || 'qwen2.5-coder:14b-instruct-q4_K_M';
var QWEN_DIRECT_TIMEOUT_MS = 600000;

// ADR-0029 Phase 1 (2026-05-05): 2nd-Pass-Modell konfigurierbar via ENV.
// Werte: 'deepseek-v4-pro' (default ab Mac-Qwen-Deprecation), 'qwen-14b-direct'
// (legacy Fallback), oder beliebiger Tailscale-Model-Identifier (z.B. künftig
// 'qwen3-coder:32b' oder 'glm-4.5-air' nach Mac-Studio-Umstellung).
// Leer = automatische Routing-Logik (shouldUseDeepSeekFor2ndPass).
var CRA_2ND_PASS_MODEL = (process.env.CRA_2ND_PASS_MODEL || '').trim();

function callOllamaDirect(prompt) {
  return new Promise(function(resolve) {
    var payload = JSON.stringify({
      model: QWEN_DIRECT_MODEL,
      system: SYSTEM_PROMPT,
      prompt: prompt,
      stream: false,
      options: { temperature: 0.1, num_ctx: 16384 }
    });
    var parts = OLLAMA_HOST.split(':');
    var opts = {
      hostname: parts[0], port: parseInt(parts[1] || '11434'),
      path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: QWEN_DIRECT_TIMEOUT_MS
    };
    var req = http.request(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try {
          var d = JSON.parse(body);
          resolve({ ok: true, text: d.response || '', tokens_in: d.prompt_eval_count, tokens_out: d.eval_count });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
    req.on('timeout', function() { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload); req.end();
  });
}

// Cost-Hook (Phase 4 Bug-Fix 2026-04-27): Schreibt jeden LLM-Call in cra_llm_usage.
// Haiku-Pricing claude-haiku-4-5: $0.001/1k in, $0.005/1k out.
// DeepSeek V4 Pricing (28.04.2026, Discount-Periode bis 31.05.2026):
//   - deepseek-chat (V4-Flash non-thinking):   in $0.14/M cm, $0.0028/M ch, out $0.28/M
//   - deepseek-reasoner (V4-Flash thinking):   gleiches Pricing
//   - deepseek-v4-pro (Discount):              in $0.435/M cm, $0.003625/M ch, out $0.87/M
// Qwen lokal = $0.
function logUsage(provider, model, tokensIn, tokensOut, context, opts) {
  var cost = 0;
  var cacheRead = (opts && opts.cacheRead) || 0;
  var cacheCreation = (opts && opts.cacheCreation) || 0;
  if (provider === 'anthropic' && model.indexOf('haiku') !== -1) {
    cost = ((tokensIn || 0) / 1000) * 0.001 + ((tokensOut || 0) / 1000) * 0.005;
  } else if (provider === 'deepseek') {
    var nonCachedIn = (tokensIn || 0) - cacheRead;
    if (nonCachedIn < 0) nonCachedIn = 0;
    if (model === 'deepseek-v4-pro') {
      cost = nonCachedIn / 1e6 * 0.435 + cacheRead / 1e6 * 0.003625 + (tokensOut || 0) / 1e6 * 0.87;
    } else {
      // V4-Flash (deepseek-chat / deepseek-reasoner) Default
      cost = nonCachedIn / 1e6 * 0.14 + cacheRead / 1e6 * 0.0028 + (tokensOut || 0) / 1e6 * 0.28;
    }
  }
  try {
    craDb.run(
      "INSERT INTO cra_llm_usage (provider, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, context) VALUES (?,?,?,?,?,?,?,?)",
      [provider, model, tokensIn || 0, tokensOut || 0, cacheCreation, cacheRead, cost, context || 'rfc-llm-review']
    );
  } catch (e) { /* swallow */ }
  return cost;
}

// DeepSeek V4 API-Client (28.04.2026, Stage C):
// https://api.deepseek.com/v1/chat/completions, JSON-Mode garantiert struktur,
// 1M Context, native Tool-Calls. System-Prompt wird automatisch gecached (kostenlos
// nach 1. Call) — entscheidend fuer Cost-Effizienz.
var DEEPSEEK_TIMEOUT_MS = 90000;
function callDeepSeekV4(prompt, opts) {
  var model = (opts && opts.model) || 'deepseek-chat';
  return new Promise(function(resolve) {
    var apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return resolve({ ok: false, error: 'no DEEPSEEK_API_KEY' });
    var payload = JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      // V4-Pro emits reasoning_content before the JSON; 800 truncated reasoning
      // and returned empty content → fallback chain → llm_review_2nd_status='no_run'.
      max_tokens: 4000
    });
    var reqOpts = {
      hostname: 'api.deepseek.com', port: 443,
      path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: DEEPSEEK_TIMEOUT_MS
    };
    var req = https.request(reqOpts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try {
          var d = JSON.parse(body);
          if (d.error) return resolve({ ok: false, error: d.error.message || JSON.stringify(d.error) });
          var msg = d.choices && d.choices[0] && d.choices[0].message;
          var u = d.usage || {};
          resolve({
            ok: !!(msg && msg.content),
            text: msg ? msg.content : '',
            tokens_in: u.prompt_tokens || 0,
            tokens_out: u.completion_tokens || 0,
            cache_read: u.prompt_cache_hit_tokens || 0,
            model: model
          });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
    req.on('timeout', function() { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload); req.end();
  });
}

// Cost-Cap-Waechter (Stage C): vor jedem DeepSeek-Call pruefen ob Tagesbudget
// erreicht. Wenn ueberschritten → Fallback auf Qwen-lokal. Hard-Stop, keine Soft-Warnung.
function deepseekBudgetExceeded() {
  try {
    var cap = parseFloat(process.env.DEEPSEEK_DAILY_CAP_USD || '2.00');
    var row = craDb.get(
      "SELECT COALESCE(SUM(cost_usd),0) as spent FROM cra_llm_usage WHERE provider='deepseek' AND date(created_at)=date('now','localtime')"
    );
    return (row && row.spent >= cap);
  } catch (e) { return false; }
}

// Routing-Helper (Stage C): nutze DeepSeek wenn Backlog gross + Budget frei.
// 1st-pass: V4-Flash (deepseek-chat) bei Backlog > THRESHOLD
// 2nd-pass: V4-Pro fuer HIGH/CRITICAL Verifikationen (hoehere Qualitaet)
function shouldUseDeepSeekFor1stPass() {
  if (!process.env.DEEPSEEK_API_KEY) return false;
  if (deepseekBudgetExceeded()) return false;
  var threshold = parseInt(process.env.DEEPSEEK_BACKLOG_THRESHOLD || '500', 10);
  try {
    var row = craDb.get("SELECT COUNT(*) as cnt FROM rfc_runs WHERE llm_review_status IS NULL");
    return row && row.cnt >= threshold;
  } catch (e) { return false; }
}
function shouldUseDeepSeekFor2ndPass() {
  if (!process.env.DEEPSEEK_API_KEY) return false;
  if (deepseekBudgetExceeded()) return false;
  return true;
}

// LCR-Opt-C (2026-04-28): Slim Prompt — von ~500 auf ~200 Token komprimiert.
// Wesentliche Semantik unveraendert: status/severity/confidence/concerns.
// Cache-Hit-optimiert: stabil identisch ueber Calls.
var SYSTEM_PROMPT = 'Code-Security-Reviewer. Pruefe ob regel-basierte CRA-Bewertung plausibel ist.\n\n' +
'Antworte NUR mit JSON: {"status":"agree"|"disagree","severity":"CRITICAL"|"HIGH"|"MEDIUM"|"LOW"|"IGNORE","confidence":0.0-1.0,"concerns":"max 300 Zeichen"}\n\n' +
'agree=Regel ok. disagree=Risiko uebersehen ODER False-Positive. severity=dein Urteil. concerns=Begruendung.';

function buildPrompt(rfc) {
  return 'RFC-Analyse-Kontext:\n' +
    'Repo: ' + (rfc.app_name || '?') + '\n' +
    'Branch: ' + (rfc.branch || '?') + '\n' +
    'Commit-Message: ' + ((rfc.title || '').substring(0, 200)) + '\n' +
    'Regel-basierter Score: ' + (rfc.risk_score || 0) + ' (Level: ' + (rfc.risk_level || 'unknown') + ')\n' +
    'Regel-basiertes Urteil: ' + (rfc.overall_status || '?') + '\n' +
    'Findings (regel-basiert):\n' + (rfc.findings_json || '[]') + '\n\n' +
    'Diff (gekuerzt):\n' + ((rfc.report_text || '').substring(0, 6000)) + '\n\n' +
    'Bewerte: stimmst du dem regel-basierten Urteil zu? Sieht du was Wichtiges uebersehen?';
}

// ── Groq (Llama 3.3 70B Versatile) — LCR-Opt-A Tier-0 (kostenlos, 30 req/min) ────
// Schneller als DeepSeek (~1-2s) UND gratis. Limitiert: nur fuer Bulk-Klassifikation
// mit niedrigem Quality-Floor. Bei confidence < 0.85 → eskaliert zu DeepSeek.
function callGroq(prompt) {
  return new Promise(function(resolve) {
    if (!process.env.GROQ_API_KEY) return resolve({ ok: false, error: 'GROQ_API_KEY nicht gesetzt' });
    var payload = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      max_tokens: 400, temperature: 0.1,
      response_format: { type: 'json_object' }
    });
    var opts = {
      hostname: 'api.groq.com', port: 443,
      path: '/openai/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.GROQ_API_KEY,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 15000
    };
    var req = https.request(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try {
          var d = JSON.parse(body);
          if (d.error) return resolve({ ok: false, error: d.error.message || 'groq error' });
          var msg = d.choices && d.choices[0] && d.choices[0].message;
          var u = d.usage || {};
          resolve({
            ok: !!(msg && msg.content),
            text: msg ? msg.content : '',
            tokens_in: u.prompt_tokens || 0,
            tokens_out: u.completion_tokens || 0
          });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
    req.on('timeout', function() { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload); req.end();
  });
}

// LCR-Opt-A: Groq nutzbar? Erst wenn Key da, kein active rate-limit-cooldown.
// Phase 2 Filter (28.04.2026): nur HARD-FAIL CRITICAL-Patterns skippen Groq —
// Patterns wo False-Negative = Security-Bug. Soft-CRITICALs (Auth-Code-Aenderung,
// Destruktive Op) gehen zu Groq weil dort viele False-Positives existieren und
// Groq die diff/intent meistens richtig klassifiziert.
//
// Hard-Fail-Patterns (immer DeepSeek):
//   risk-03 = Hardcoded Secret
//   risk-12 = Security-Middleware entfernt
//   risk-14 = SQL Injection Risiko
//   vuln-* = Vulnerability-Findings (bereits durch SAST gefunden)
var GROQ_HARDFAIL_PATTERNS = ['risk-03', 'risk-12', 'risk-14'];

function shouldTryGroq(rfc) {
  if (!process.env.GROQ_API_KEY) return false;
  if (process.env.LCR_DISABLE_GROQ === '1') return false;
  try {
    var findings = JSON.parse(rfc.findings_json || '[]');
    var hasHardFail = findings.some(function(f) {
      if (!f) return false;
      var sev = f.severity || '';
      // Vuln-Findings (SAST) NUR bei HIGH/CRITICAL → DeepSeek (LOW/MEDIUM darf Groq)
      var isVuln = f.type === 'vuln' || (f.id || '').indexOf('vuln-') === 0;
      if (isVuln && (sev === 'HIGH' || sev === 'CRITICAL')) return true;
      // Hard-Fail Risk-Patterns (Secrets, Middleware-Removal, SQL-Inj) — unabhaengig von Severity
      if (GROQ_HARDFAIL_PATTERNS.indexOf(f.id) !== -1) return true;
      return false;
    });
    if (hasHardFail) return false;
  } catch (e) {}
  return true;
}

var LCR_GROQ_CONFIDENCE_FLOOR = parseFloat(process.env.LCR_GROQ_CONFIDENCE_FLOOR || '0.85');
// ADR-0029 (Härtung 2026-05-05): Default 0.85 → 0.9, plus HIGH/CRITICAL/MEDIUM
// werden NIE per Confidence geskippt (siehe SQL-Filter in review2ndPassPending).
var LCR_SKIP_2ND_CONFIDENCE = parseFloat(process.env.LCR_SKIP_2ND_CONFIDENCE || '0.9');

// ── Anthropic Haiku ──────────────────────────────────────────────────────
function callHaiku(prompt) {
  return new Promise(function(resolve) {
    if (!ANTHROPIC_API_KEY) return resolve({ ok: false, error: 'ANTHROPIC_API_KEY nicht gesetzt' });
    var payload = JSON.stringify({
      model: HAIKU_MODEL, max_tokens: 1024, temperature: 0.1,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }]
    });
    var opts = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)
      },
      timeout: 30000
    };
    var req = https.request(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try {
          var parsed = JSON.parse(body);
          if (res.statusCode !== 200) return resolve({ ok: false, error: 'HTTP ' + res.statusCode + ': ' + (parsed.error && parsed.error.message || body.substring(0, 200)) });
          var text = (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
          resolve({ ok: true, text: text });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
    req.on('timeout', function() { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload); req.end();
  });
}

function parseReviewJson(text) {
  if (!text) return null;
  var m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    var p = JSON.parse(m[0]);
    var sev = String(p.severity || '').toUpperCase();
    if (['CRITICAL','HIGH','MEDIUM','LOW','IGNORE'].indexOf(sev) === -1) sev = null;
    var status = String(p.status || '').toLowerCase();
    if (status !== 'agree' && status !== 'disagree') status = null;
    return {
      status: status,
      severity: sev,
      confidence: parseFloat(p.confidence) || 0,
      concerns: String(p.concerns || '').substring(0, 500)
    };
  } catch (e) { return null; }
}

// ── Routing ──────────────────────────────────────────────────────────────
// Phase 4 Option D Hybrid (2026-04-25):
// - Risk-Cases (Diff>=500 OR score>=10 OR HIGH/CRITICAL findings) → Qwen 14b (höchste Quality)
// - Rest → Haiku (schnell, kostet etwas)
// Frueher: alles Qwen 7b first, Haiku-Eskalation. Mit dedicated 14b kein 7b mehr.
function routeFor(rfc) {
  var diffLen = (rfc.additions || 0) + (rfc.deletions || 0);
  var score = rfc.risk_score || 0;
  var findings = [];
  try { findings = JSON.parse(rfc.findings_json || '[]'); } catch (e) {}
  var hasHighOrCritical = findings.some(function(f) { return f.severity === 'CRITICAL' || f.severity === 'HIGH'; });
  // Risk-Cases → Qwen (auf 14b dedicated)
  if (diffLen >= 500 || score >= 10 || hasHighOrCritical) return 'qwen';
  // Rest → Haiku (schneller fuer Bulk)
  return 'haiku';
}

// ── Public API ───────────────────────────────────────────────────────────
async function reviewRfc(rfcId) {
  var rfc = craDb.get('SELECT * FROM rfc_runs WHERE id = ?', [rfcId]);
  if (!rfc) return { ok: false, error: 'RFC nicht gefunden: ' + rfcId };
  if (rfc.llm_review_status) return { ok: true, skipped: true, reason: 'bereits reviewed' };

  var route = routeFor(rfc);
  var prompt = buildPrompt(rfc);
  var result;
  var reviewer;

  // LCR-Opt-A (2026-04-28): Tier-0 Groq versuchen wenn nicht-CRITICAL.
  // Wenn confidence >= LCR_GROQ_CONFIDENCE_FLOOR → keep Groq-Result (kostenlos).
  // Sonst eskaliere zu DeepSeek (Tier-1) oder Qwen-Fallback.
  if (shouldTryGroq(rfc)) {
    var gRes = await callGroq(prompt);
    if (gRes.ok) {
      var gParsed = parseReviewJson(gRes.text);
      if (gParsed && (gParsed.confidence || 0) >= LCR_GROQ_CONFIDENCE_FLOOR) {
        result = gParsed;
        reviewer = 'groq-llama3.3-70b';
        logUsage('groq', 'llama-3.3-70b-versatile', gRes.tokens_in, gRes.tokens_out, 'rfc-llm-review-1st-groq');
      }
      // sonst: result bleibt undefined → Eskalation zu DeepSeek unten
    }
  }

  // Stage C (28.04.2026): wenn Backlog > THRESHOLD und Budget frei → DeepSeek V4-Flash
  // statt lokaler Qwen-Sequenz (5-10x schneller, $0.0003/RFC).
  var useDeepSeek = !result && shouldUseDeepSeekFor1stPass();

  if (useDeepSeek) {
    var dRes = await callDeepSeekV4(prompt, { model: 'deepseek-chat' });
    if (dRes.ok) {
      result = parseReviewJson(dRes.text);
      reviewer = 'deepseek-v4-flash';
      logUsage('deepseek', dRes.model, dRes.tokens_in, dRes.tokens_out, 'rfc-llm-review-1st-deepseek', { cacheRead: dRes.cache_read });
    }
    // Bei DeepSeek-Fehler: Qwen-Fallback (gratis, lokal)
    if (!result) {
      var qResD = await callOllamaDirect(prompt);
      if (qResD.ok) {
        result = parseReviewJson(qResD.text);
        reviewer = 'qwen-14b-fallback-after-deepseek';
        logUsage('ollama', QWEN_DIRECT_MODEL, qResD.tokens_in, qResD.tokens_out, 'rfc-llm-review-1st-fallback-qwen');
      }
    }
  } else if (!result && route === 'qwen') {
    // Phase 4 Bug-Fix 2026-04-27: Direct-Ollama (umgeht prep-Worker-diff-Constraint)
    var qRes = await callOllamaDirect(prompt);
    if (qRes.ok) {
      result = parseReviewJson(qRes.text);
      reviewer = 'qwen-14b-direct';
      logUsage('ollama', QWEN_DIRECT_MODEL, qRes.tokens_in, qRes.tokens_out, 'rfc-llm-review-1st');
    }
    // Bei Qwen-Fehler oder schlechtem Output: Haiku Fallback
    if (!result) {
      var hRes2 = await callHaiku(prompt);
      if (hRes2.ok) {
        result = parseReviewJson(hRes2.text);
        reviewer = 'haiku-fallback';
        logUsage('anthropic', HAIKU_MODEL, hRes2.usage && hRes2.usage.input_tokens, hRes2.usage && hRes2.usage.output_tokens, 'rfc-llm-review-1st-fallback');
      }
    }
  } else if (!result) {
    var hRes3 = await callHaiku(prompt);
    if (hRes3.ok) {
      result = parseReviewJson(hRes3.text);
      reviewer = 'haiku';
      logUsage('anthropic', HAIKU_MODEL, hRes3.usage && hRes3.usage.input_tokens, hRes3.usage && hRes3.usage.output_tokens, 'rfc-llm-review-1st');
    }
  }

  if (!result) {
    craDb.run(
      "UPDATE rfc_runs SET llm_review_status = 'no_run', llm_review_at = datetime('now','localtime') WHERE id = ?",
      [rfcId]
    );
    craDb.saveCraDb();
    return { ok: false, error: 'kein LLM-Result', reviewer: reviewer || 'none' };
  }

  craDb.run(
    `UPDATE rfc_runs SET
       llm_review_status = ?, llm_review_severity = ?,
       llm_review_concerns = ?, llm_review_by = ?,
       llm_review_confidence = ?,
       llm_review_at = datetime('now','localtime')
     WHERE id = ?`,
    [result.status || 'agree', result.severity, result.concerns, reviewer, result.confidence || 0, rfcId]
  );
  craDb.saveCraDb();

  // Audit
  try {
    craDb.run(
      'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
      ['rfc-llm-review', result.status || 'no-status', rfc.app_name, rfcId,
       'reviewer=' + reviewer + ' sev=' + result.severity + ' conf=' + result.confidence +
       (result.status === 'disagree' ? ' DISAGREE: ' + (result.concerns || '').substring(0, 200) : '')]
    );
    craDb.saveCraDb();
  } catch (e) {}

  return { ok: true, rfcId: rfcId, route: route, reviewer: reviewer, result: result };
}

// Cron-Worker: review aller RFCs ohne llm_review_status
// opts: { maxRfcs, since?, until?, onlyAppName?, onlyRiskLevel?, includeNoRun? }
//   since/until: ISO-Date oder relativ ('-7 days', '-30 days'). Default: '-7 days' bis 'now'.
//   onlyAppName: filter auf app_name (z.B. 'kursmanager-platform')
//   onlyRiskLevel: 'HIGH'|'CRITICAL'|... — nur RFCs dieses risk_level
//   includeNoRun: true → auch llm_review_status='no_run' RFCs reviewn (Retry)
async function reviewPendingRfcs(opts) {
  opts = opts || {};
  var maxRfcs = opts.maxRfcs || 10;
  var since = opts.since || "datetime('now','localtime','-7 days')";
  var until = opts.until || "datetime('now','localtime')";
  // Wenn since/until ein ISO-Datum ist (enthält '-' und kein 'datetime('), als Literal escapen
  var sinceExpr = /^(datetime|date)\(/.test(since) ? since : "'" + String(since).replace(/'/g, "''") + "'";
  var untilExpr = /^(datetime|date)\(/.test(until) ? until : "'" + String(until).replace(/'/g, "''") + "'";

  var statusFilter = opts.includeNoRun
    ? "(llm_review_status IS NULL OR llm_review_status = 'no_run')"
    : "llm_review_status IS NULL";
  var sql = "SELECT id FROM rfc_runs WHERE " + statusFilter +
    " AND created_at >= " + sinceExpr +
    " AND created_at <= " + untilExpr;
  var params = [];
  if (opts.onlyAppName) { sql += " AND app_name = ?"; params.push(opts.onlyAppName); }
  if (opts.onlyRiskLevel) { sql += " AND risk_level = ?"; params.push(opts.onlyRiskLevel); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(maxRfcs);

  // Wenn includeNoRun: vorher reset auf NULL damit reviewRfc nicht skipped
  if (opts.includeNoRun) {
    craDb.run(
      "UPDATE rfc_runs SET llm_review_status=NULL WHERE llm_review_status='no_run'" +
      " AND created_at >= " + sinceExpr + " AND created_at <= " + untilExpr
    );
    craDb.saveCraDb();
  }

  var rfcs = craDb.all(sql, params);
  var results = [];
  for (var i = 0; i < rfcs.length; i++) {
    try {
      var r = await reviewRfc(rfcs[i].id);
      results.push({ id: rfcs[i].id, ok: r.ok, status: r.result && r.result.status });
    } catch (e) {
      results.push({ id: rfcs[i].id, ok: false, error: e.message });
    }
  }
  return { reviewed: results.length, results: results };
}

// Phase 4 Option D: 2nd-Pass-Verify mit dedicated 14b
// Kandidaten: alle disagrees + alle BLOCKED + alle HIGH/CRITICAL findings,
// die noch keinen 2nd-pass haben.
// ADR-0029 Phase 2a (Hardening 2026-05-10): GitHub-Status-Push nach 2nd-Pass.
// Wird in JEDEM Exit-Pfad von review2ndPass aufgerufen (success, no_run, parse-fail).
// reEvaluateStatus() postet nur im disagree-with-1st-Pfad — Vorfall 2026-05-09 PR #434/#437/#439.
function pushFinal2ndPassStatus(rfcId) {
  try {
    var refreshed = craDb.get('SELECT * FROM rfc_runs WHERE id = ?', [rfcId]);
    if (refreshed && refreshed.commit_sha && refreshed.repo_full_name) {
      var ghs = require('./github-status');
      ghs.post2ndPassFinal(refreshed).catch(function() {});
    }
  } catch (_) {}
}

async function review2ndPass(rfcId) {
  var rfc = craDb.get('SELECT * FROM rfc_runs WHERE id = ?', [rfcId]);
  if (!rfc) return { ok: false, error: 'RFC nicht gefunden' };
  if (rfc.llm_review_2nd_status) return { ok: true, skipped: true, reason: '2nd-pass bereits gemacht' };

  var prompt = '2ND-PASS-VERIFY (Phase 4 Option D): unabhaengige Re-Bewertung mit dedicated 14b.\n' +
    '1st-pass-Result: status=' + (rfc.llm_review_status || '?') + ', sev=' + (rfc.llm_review_severity || '?') +
    ', concerns="' + (rfc.llm_review_concerns || '').substring(0, 200) + '"\n\n' +
    buildPrompt(rfc);
  // ADR-0029 Phase 1: ENV-Override CRA_2ND_PASS_MODEL hat Vorrang über Routing-Logik.
  // Leer → automatische Wahl (Stage C: DeepSeek V4-Pro mit Qwen-Fallback).
  var forcedModel = CRA_2ND_PASS_MODEL;
  var useDeepSeek2 = forcedModel === 'deepseek-v4-pro' || (!forcedModel && shouldUseDeepSeekFor2ndPass());
  var useQwenDirect = forcedModel === 'qwen-14b-direct' || forcedModel.indexOf('qwen') === 0 || forcedModel.indexOf('glm') === 0;
  var reviewer2 = 'qwen-14b-direct';
  try {
    var qRes;
    if (useDeepSeek2) {
      qRes = await callDeepSeekV4(prompt, { model: 'deepseek-v4-pro' });
      if (qRes.ok) {
        reviewer2 = 'deepseek-v4-pro';
        logUsage('deepseek', qRes.model, qRes.tokens_in, qRes.tokens_out, 'rfc-llm-review-2nd-deepseek', { cacheRead: qRes.cache_read });
      }
    }
    // Forced Tailscale-Modell hat Priorität wenn gesetzt; sonst Fallback wenn DeepSeek nicht ok.
    if ((!qRes || !qRes.ok) || (useQwenDirect && reviewer2 !== forcedModel)) {
      qRes = await callOllamaDirect(prompt);
      if (qRes.ok) {
        reviewer2 = forcedModel && useQwenDirect ? forcedModel : 'qwen-14b-direct';
        logUsage('ollama', QWEN_DIRECT_MODEL, qRes.tokens_in, qRes.tokens_out, 'rfc-llm-review-2nd');
      }
    }
    if (!qRes.ok) {
      craDb.run("UPDATE rfc_runs SET llm_review_2nd_status='no_run', llm_review_2nd_at=datetime('now','localtime') WHERE id=?", [rfcId]);
      pushFinal2ndPassStatus(rfcId);
      return { ok: false, error: '2nd-pass alle Provider failed: ' + qRes.error };
    }
    var result = parseReviewJson(qRes.text);
    if (!result) {
      craDb.run("UPDATE rfc_runs SET llm_review_2nd_status='no_run', llm_review_2nd_at=datetime('now','localtime') WHERE id=?", [rfcId]);
      pushFinal2ndPassStatus(rfcId);
      return { ok: false, error: 'kein JSON in 2nd-pass output' };
    }
    // 2nd-status: ueber 1st-vs-2nd-Vergleich
    var stat2 = (result.status === rfc.llm_review_status) ? 'agree-with-1st' : 'disagree-with-1st';
    // ADR-0029 Phase 1: 2nd-Pass-Confidence persistieren (Schema-Migration in cra-db.js).
    craDb.run(
      `UPDATE rfc_runs SET llm_review_2nd_status=?, llm_review_2nd_severity=?, llm_review_2nd_concerns=?,
         llm_review_2nd_by=?, llm_review_2nd_confidence=?, llm_review_2nd_at=datetime('now','localtime')
       WHERE id=?`,
      [stat2, result.severity, String(result.concerns || '').substring(0, 500), reviewer2,
       result.confidence || 0, rfcId]
    );
    craDb.saveCraDb();
    try {
      craDb.run('INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
        ['rfc-llm-review-2nd', stat2, rfc.app_name, rfcId,
         reviewer2 + ' sev=' + result.severity + ' conf=' + (result.confidence || 0).toFixed(2) +
         ' vs 1st=' + (rfc.llm_review_severity || '?') +
         (stat2 === 'disagree-with-1st' ? ' DIVERGENT — User-Review!' : '')]);
      craDb.saveCraDb();
    } catch (e) {}
    // ADR-0029 Phase 1: Status-Re-Evaluation synchron nach 2nd-Pass-Persistierung.
    // Bei Exception: Status unverändert + Audit-Eintrag, kein Pipeline-Crash.
    try { reEvaluateStatus(rfcId); } catch (e) {
      try {
        appendStatusChangeLog(rfcId, {
          ts: new Date().toISOString(), from: rfc.overall_status, to: rfc.overall_status,
          reason: 're-eval-error', error: String(e.message || e).substring(0, 200)
        });
      } catch (_) {}
    }
    pushFinal2ndPassStatus(rfcId);
    return { ok: true, rfcId: rfcId, status_2nd: stat2, result: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── ADR-0029 Phase 1: Status-Re-Evaluation ─────────────────────────────
// Hebt overall_status nach 2nd-Pass-Result an, wenn Severity-Eskalation oberhalb
// der gehärteten Confidence-Schwellen detektiert wird. De-Eskalation niemals
// automatisch — nur Hint im Dashboard via status_re_eval_reason.
//
// Härtungs-Prinzip (ADR-0029): Code-Qualität schlägt False-Positive-Komfort.
// FP-Korrektur erfolgt explizit via Admin-Override, nicht algorithmisch.

var SEVERITY_RANK = { 'IGNORE': 0, 'NONE': 0, 'LOW': 1, 'MEDIUM': 2, 'HIGH': 3, 'CRITICAL': 4 };
var ESCALATION_CONFIDENCE_THRESHOLD = parseFloat(process.env.CRA_REEVAL_ESCALATION_CONF || '0.6');
var DE_ESCALATION_CONFIDENCE_THRESHOLD = parseFloat(process.env.CRA_REEVAL_DEESCALATION_CONF || '0.9');

function rankSeverity(sev) {
  return SEVERITY_RANK[String(sev || '').toUpperCase()] || 0;
}

// Doc-only-Skip: nur reine Markdown-Änderungen ohne Code-Berührung.
// package.json-Version-Bumps gelten NICHT als doc-only (Lockfile-Risiko, ADR-0029).
function isDocOnlyChange(findingsJson) {
  if (!findingsJson) return false;
  try {
    var arr = typeof findingsJson === 'string' ? JSON.parse(findingsJson) : findingsJson;
    if (!Array.isArray(arr) || !arr.length) return false;
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i] || {};
      var file = String(f.file || f.path || '').toLowerCase();
      if (!file) continue;
      if (!/\.(md|markdown|txt|rst)$/.test(file)) return false;
    }
    return true;
  } catch (e) { return false; }
}

function hasConcreteFileLineRef(text) {
  if (!text) return false;
  return /\b\S+\.(js|ts|tsx|jsx|mjs|cjs|py|sh|sql|html|css|yml|yaml|json)(:\d+)?\b/i.test(String(text));
}

function appendStatusChangeLog(rfcId, entry) {
  var rfc = craDb.get('SELECT status_change_log FROM rfc_runs WHERE id = ?', [rfcId]);
  var arr = [];
  if (rfc && rfc.status_change_log) {
    try { arr = JSON.parse(rfc.status_change_log) || []; } catch (e) { arr = []; }
  }
  arr.push(entry);
  if (arr.length > 50) arr = arr.slice(-50); // Cap, sonst wächst die Spalte unbegrenzt.
  craDb.run('UPDATE rfc_runs SET status_change_log=? WHERE id=?', [JSON.stringify(arr), rfcId]);
}

function reEvaluateStatus(rfcId) {
  var rfc = craDb.get('SELECT * FROM rfc_runs WHERE id = ?', [rfcId]);
  if (!rfc) return { ok: false, reason: 'rfc-not-found' };
  if (rfc.llm_review_2nd_status !== 'disagree-with-1st') {
    return { ok: true, skipped: true, reason: '2nd-pass-not-disagree' };
  }
  if (isDocOnlyChange(rfc.findings_json)) {
    return { ok: true, skipped: true, reason: 'doc-only-skip' };
  }

  var sev1 = rankSeverity(rfc.llm_review_severity);
  var sev2 = rankSeverity(rfc.llm_review_2nd_severity);
  var conf2 = parseFloat(rfc.llm_review_2nd_confidence) || 0;
  var oldStatus = rfc.overall_status;
  var newStatus = oldStatus;
  var reason = null;

  // Eskalation: 2nd > 1st mit Confidence ≥ 0.6
  if (sev2 > sev1 && conf2 >= ESCALATION_CONFIDENCE_THRESHOLD) {
    var sev2Up = String(rfc.llm_review_2nd_severity || '').toUpperCase();
    if (sev2Up === 'CRITICAL') {
      newStatus = 'BLOCKED';
      reason = 'esk-critical';
    } else if (sev2Up === 'HIGH') {
      newStatus = 'BLOCKED'; // ADR-0029-Härtung: HIGH eskaliert blockiert
      reason = 'esk-high';
    } else if (sev2Up === 'MEDIUM' && sev1 <= 1) {
      newStatus = 'NEEDS_REVIEW';
      reason = 'esk-medium-from-low';
    }
  }
  // De-Eskalation: nur Hint, keine Auto-Status-Änderung
  else if (sev2 < sev1 && conf2 >= DE_ESCALATION_CONFIDENCE_THRESHOLD) {
    var sev1Up = String(rfc.llm_review_severity || '').toUpperCase();
    var sev2Up2 = String(rfc.llm_review_2nd_severity || '').toUpperCase();
    if (oldStatus === 'BLOCKED'
        && rfc.gate1_status === 'PASSED'
        && rfc.gate3_status === 'PASSED'
        && (sev1Up === 'HIGH' || sev1Up === 'CRITICAL')
        && sev2Up2 === 'IGNORE'
        && !hasConcreteFileLineRef(rfc.llm_review_concerns)) {
      reason = 'de-esk-hint'; // Status bleibt, aber UI zeigt Hint
    }
  }

  if (newStatus !== oldStatus || reason === 'de-esk-hint') {
    appendStatusChangeLog(rfcId, {
      ts: new Date().toISOString(),
      from: oldStatus,
      to: newStatus,
      reason: reason,
      by_model: rfc.llm_review_2nd_by,
      confidence: conf2
    });
    if (newStatus !== oldStatus) {
      craDb.run('UPDATE rfc_runs SET overall_status=?, status_re_eval_reason=? WHERE id=?',
        [newStatus, reason, rfcId]);
      try {
        craDb.run('INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
          ['rfc-status-re-eval', reason, rfc.app_name, rfcId,
           'status ' + oldStatus + ' → ' + newStatus + ' (sev1=' + (rfc.llm_review_severity || '?') +
           ' sev2=' + (rfc.llm_review_2nd_severity || '?') + ' conf=' + conf2.toFixed(2) + ')']);
      } catch (e) {}
    } else if (reason === 'de-esk-hint') {
      craDb.run('UPDATE rfc_runs SET status_re_eval_reason=? WHERE id=?', [reason, rfcId]);
    }
    craDb.saveCraDb();
  } else {
    // ADR-0029 Phase E: Audit-Eintrag auch bei Disagree ohne Status-Change.
    // Why: status_change_log soll vollständige Spur ALLER 2nd-Pass-Entscheidungen
    // werden, nicht nur Eskalations-Subset. Beobachtungs-Report 2026-05-07 zeigte
    // 268 Disagree-Cases ohne einen einzigen log-Eintrag — Audit-Trail-Lücke.
    appendStatusChangeLog(rfcId, {
      ts: new Date().toISOString(),
      from: oldStatus,
      to: oldStatus,
      reason: 'disagree-no-change',
      by_model: rfc.llm_review_2nd_by,
      confidence: conf2,
      sev1: rfc.llm_review_severity,
      sev2: rfc.llm_review_2nd_severity
    });
    craDb.saveCraDb();
  }

  // ADR-0029 Phase 2a: GitHub-Status-Push erfolgt zentral in pushFinal2ndPassStatus()
  // im review2ndPass-Caller — egal welcher Re-Eval-Pfad hier gewählt wurde.
  // Eigener Push hier wäre Doppel-Post (gleicher Endzustand, eine Sekunde später).

  return { ok: true, oldStatus: oldStatus, newStatus: newStatus, reason: reason, confidence: conf2 };
}

// Pickt 2nd-Pass-Kandidaten + processed sequenziell. Cost-aware.
// LCR-Opt-B (28.04.2026, gehärtet 05.05.2026 per ADR-0029):
// Original-Heuristik: Skip 2nd-Pass bei 1st-pass-confidence >= 0.85.
// Härtung: HIGH/CRITICAL/MEDIUM-Risiken werden NIE per Confidence geskippt —
// FP-Last trägt der Admin via Override, nicht der Algorithmus per Toleranz.
// Default-Confidence-Schwelle 0.85 → 0.9 (LCR_SKIP_2ND_CONFIDENCE).
// Kandidatenfilter erweitert um MEDIUM (vorher nur HIGH/CRITICAL).
// opts: { maxRfcs, since?, until?, onlyAppName?, ignoreConfidence? }
//   ignoreConfidence: true → LCR-Skip umgehen (auch confidence>=Schwelle reviewn)
async function review2ndPassPending(opts) {
  opts = opts || {};
  var maxRfcs = opts.maxRfcs || 5;
  var since = opts.since || null;
  var until = opts.until || null;
  var sinceExpr = since ? (/^(datetime|date)\(/.test(since) ? since : "'" + String(since).replace(/'/g, "''") + "'") : null;
  var untilExpr = until ? (/^(datetime|date)\(/.test(until) ? until : "'" + String(until).replace(/'/g, "''") + "'") : null;

  var sql = "SELECT id FROM rfc_runs WHERE llm_review_status IS NOT NULL " +
    " AND llm_review_status != 'no_run' " +
    " AND llm_review_2nd_status IS NULL " +
    " AND (risk_level IN ('HIGH','CRITICAL','MEDIUM') OR llm_review_severity IN ('HIGH','CRITICAL','MEDIUM'))";
  var params = [];
  if (!opts.ignoreConfidence) {
    // ADR-0029 Härtung: Confidence-Skip wirkt NICHT auf HIGH/CRITICAL/MEDIUM.
    // Nur bei LOW/IGNORE/NONE (die den Kandidatenfilter ohnehin nicht passieren)
    // wäre der Skip relevant — die Klausel bleibt für künftige Erweiterungen.
    sql += " AND (llm_review_confidence IS NULL OR llm_review_confidence < ? " +
           "      OR risk_level IN ('HIGH','CRITICAL','MEDIUM') " +
           "      OR llm_review_severity IN ('HIGH','CRITICAL','MEDIUM'))";
    params.push(LCR_SKIP_2ND_CONFIDENCE);
  }
  if (sinceExpr) sql += " AND created_at >= " + sinceExpr;
  if (untilExpr) sql += " AND created_at <= " + untilExpr;
  if (opts.onlyAppName) { sql += " AND app_name = ?"; params.push(opts.onlyAppName); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(maxRfcs);
  var rfcs = craDb.all(sql, params);
  return await __runReview2ndOn(rfcs);
}

// Helper: führt review2ndPass auf einer Liste von RFCs aus
async function __runReview2ndOn(rfcs) {
  var results = [];
  for (var i = 0; i < rfcs.length; i++) {
    try {
      var r = await review2ndPass(rfcs[i].id);
      results.push({ id: rfcs[i].id, ok: r.ok, status_2nd: r.status_2nd });
    } catch (e) {
      results.push({ id: rfcs[i].id, ok: false, error: e.message });
    }
  }
  return { reviewed: results.length, results: results };
}

function get2ndPassStats() {
  var by2nd = craDb.all(
    "SELECT llm_review_2nd_status as status, COUNT(*) as cnt FROM rfc_runs WHERE llm_review_2nd_status IS NOT NULL GROUP BY llm_review_2nd_status"
  );
  var divergent = craDb.all(
    `SELECT id, app_name, branch, risk_score, llm_review_severity, llm_review_2nd_severity,
            llm_review_2nd_concerns, llm_review_2nd_at
     FROM rfc_runs WHERE llm_review_2nd_status = 'disagree-with-1st'
       AND llm_review_severity IS NOT NULL AND llm_review_2nd_severity IS NOT NULL
       AND llm_review_severity != llm_review_2nd_severity
     ORDER BY llm_review_2nd_at DESC LIMIT 50`
  );
  var pending = craDb.get(
    `SELECT COUNT(*) as cnt FROM rfc_runs
     WHERE llm_review_status IS NOT NULL AND llm_review_status != 'no_run'
       AND llm_review_2nd_status IS NULL
       AND (llm_review_status = 'disagree' OR overall_status = 'BLOCKED' OR llm_review_severity IN ('HIGH','CRITICAL'))`
  );
  return {
    by_status: by2nd,
    divergent_cases: divergent,
    pending_2nd_pass: pending ? pending.cnt : 0
  };
}

function getReviewStats() {
  var byStatus = craDb.all(
    "SELECT llm_review_status as status, COUNT(*) as cnt FROM rfc_runs WHERE llm_review_status IS NOT NULL GROUP BY llm_review_status"
  );
  var disagreements = craDb.all(
    "SELECT id, app_name, branch, risk_score, llm_review_severity, llm_review_concerns, llm_review_at FROM rfc_runs WHERE llm_review_status = 'disagree' ORDER BY llm_review_at DESC LIMIT 20"
  );
  var pending = craDb.get(
    "SELECT COUNT(*) as cnt FROM rfc_runs WHERE llm_review_status IS NULL AND created_at > datetime('now','localtime','-7 days')"
  );
  return {
    by_status: byStatus,
    pending_last_7d: pending ? pending.cnt : 0,
    recent_disagreements: disagreements
  };
}

module.exports = {
  reviewRfc: reviewRfc,
  reviewPendingRfcs: reviewPendingRfcs,
  getReviewStats: getReviewStats,
  routeFor: routeFor,
  parseReviewJson: parseReviewJson,
  // Phase 4 Option D
  review2ndPass: review2ndPass,
  review2ndPassPending: review2ndPassPending,
  reEvaluateStatus: reEvaluateStatus,
  get2ndPassStats: get2ndPassStats
};
