// admin/cra/cra-api.js — CRA API Route Handler (CommonJS)
var craDb = require('./cra-db');
var craRules = require('./cra-rules');
var craAnalyzer = require('./cra-analyzer');
var craFsc = require('./cra-fsc');
var craReview = require('./cra-review-engine');
var craDispatcher = require('./cra-dispatcher');
var craTestOrch = require('./cra-test-orchestrator');
var craEscalation = require('./cra-escalation');
var craLearning = require('./cra-learning');
var deploySafety = require('./cra-deploy-safety');
var githubStatus = require('./github-status');
var githubChecks = require('./github-checks');
var plugins = require('../lib/plugins');
var qwenClient = plugins.load('qwen-client'); // optional (CRA-Plus-Plugin via MERIDIAN_PLUGINS_DIR)
var toolFindings = require('./tool-findings');
var toolFindingsClassifier = require('./tool-findings-classifier');
var rfcLlmReview = require('./rfc-llm-review');
var lightsOut = plugins.load('lights-out-api'); // optional (CRA-Plus-Plugin via MERIDIAN_PLUGINS_DIR)
var watchdog = require('./watchdog-api');

// Einmalige DB-Migrationen (idempotent, ALTER TABLE / CREATE IF NOT EXISTS)
try { if (lightsOut) lightsOut.ensureGtmJobsTable(); } catch (e) { console.error('[CRA/init] gtm-jobs:', e.message); }
try { watchdog.ensureWatchdogColumns(); } catch (e) { console.error('[CRA/init] watchdog-cols:', e.message); }

var CRA_TOKEN = process.env.CRA_API_TOKEN;
if (!CRA_TOKEN) {
  console.error('[CRA/API] FATAL: CRA_API_TOKEN ist nicht gesetzt! Token-Auth deaktiviert.');
}

var CRA_OVERRIDE_TOKEN = process.env.CRA_OVERRIDE_TOKEN || '';

// Machine-to-Machine Auth (MCP-Server + Hooks + Worker)
function tokenAuth(req) {
  if (!CRA_TOKEN) return false;
  var h = req.headers['x-cra-token'];
  if (!h) return false;
  return h === CRA_TOKEN || h === CRA_OVERRIDE_TOKEN;
}

// Override-Auth: nur Override-Token oder Dashboard-Session (NICHT Worker-Token)
function overrideAuth(req, authed) {
  if (CRA_OVERRIDE_TOKEN) {
    var h = req.headers['x-cra-token'];
    if (h && h === CRA_OVERRIDE_TOKEN) return 'override-token';
  }
  if (authed && authed(req)) return 'dashboard';
  return false;
}

// body() wird von server.js uebergeben
function craApi(req, res, url, opts) {
  var json = opts.json;
  var authed = opts.authed;
  var bodyFn = opts.body;

  // ── Oeffentliche Endpoints (Token-Auth fuer MCP/Hooks) ────────

  // MCP-Server postet Pipeline-Ergebnis
  if (url === '/api/cra/rfc-report' && req.method === 'POST') {
    if (!tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        // sql.js kann kein undefined binden — alle Felder normalisieren
        var v = function(x) { return x === undefined ? null : x; };
        craDb.run(
          `INSERT OR REPLACE INTO rfc_runs (id, title, change_type, repo_path, app_name, diff_source,
            risk_score, risk_level, gate1_status, gate1_details, gate2_status, gate2_details,
            gate3_status, gate3_details, overall_status, approved_by, additions, deletions,
            findings_json, report_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [p.id, p.title, v(p.changeType), v(p.path), v(p.appName), v(p.diffSource),
           p.riskScore || 0, v(p.riskLevel), v(p.gate1Status), v(p.gate1Details),
           v(p.gate2Status), v(p.gate2Details), v(p.gate3Status), v(p.gate3Details),
           v(p.overallStatus), v(p.approvedBy), p.additions || 0, p.deletions || 0,
           p.findingsJson ? JSON.stringify(p.findingsJson) : null, v(p.reportText)]
        );
        craDb.saveCraDb();
        console.log('[CRA/API] RFC gespeichert:', p.id, p.overallStatus);
        json(res, { ok: true, id: p.id });
      } catch (e) {
        console.error('[CRA/API] RFC-Report Fehler:', String(e));
        json(res, { error: String(e) });
      }
    });
  }

  // Hooks posten Events
  if (url === '/api/cra/hook-event' && req.method === 'POST') {
    if (!tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        craDb.run(
          'INSERT INTO hook_events (hook_name, event_type, command, repo_name, rfc_id, details) VALUES (?,?,?,?,?,?)',
          [p.hook, p.event, p.command || null, p.repo || null, p.rfc || null, p.details || null]
        );
        craDb.saveCraDb();
        json(res, { ok: true });
      } catch (e) {
        json(res, { error: e.message });
      }
    });
  }

  // LLM Usage Log (Worker postet Cost-Daten nach jedem CLI-Call — Token-Auth)
  if (url === '/api/cra/usage/log' && req.method === 'POST') {
    if (!tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.provider || !p.model) return json(res, { error: 'provider und model sind Pflicht' });
        craDb.run(
          "INSERT INTO cra_llm_usage (provider, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, context) VALUES (?,?,?,?,?,?,?,?)",
          [p.provider, p.model,
            p.input_tokens || 0, p.output_tokens || 0,
            p.cache_creation_tokens || 0, p.cache_read_tokens || 0,
            p.cost_usd || 0, p.context || null]
        );
        craDb.saveCraDb();
        return json(res, { ok: true });
      } catch (e) {
        return json(res, { error: String(e) });
      }
    });
  }

  // Phase 4: Cost-Total fuer letzte N Stunden (fuer phase4-monitor.sh)
  if (url.indexOf('/api/cra/usage/total') === 0 && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var hoursMatch = req.url.match(/[?&]hours=(\d+)/);
    var hours = hoursMatch ? parseInt(hoursMatch[1]) : 24;
    if (hours < 1 || hours > 720) hours = 24;
    var totalRow = craDb.get(
      "SELECT ROUND(SUM(cost_usd), 4) as total_cost_usd, COUNT(*) as calls FROM cra_llm_usage WHERE created_at >= datetime('now','localtime','-" + hours + " hours')"
    );
    return json(res, { hours: hours, total_cost_usd: (totalRow && totalRow.total_cost_usd) || 0, calls: (totalRow && totalRow.calls) || 0 });
  }

  // LLM Usage Summary (cra_llm_usage Aggregation — Token ODER Session)
  if (url === '/api/cra/usage/summary' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    try {
      // since Parameter — Whitelist-Validierung (nur ISO-Datum oder SQLite datetime), Retro CRITICAL #1
      var sinceRaw = '';
      var qs = req.url.indexOf('?');
      if (qs >= 0) {
        var p = new URLSearchParams(req.url.substring(qs + 1));
        sinceRaw = p.get('since') || '';
      }
      // Akzeptiere nur: YYYY-MM-DD oder YYYY-MM-DD HH:MM:SS oder datetime('now',…) Relativwerte wie '-7 days'
      var since = '';
      if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(sinceRaw)) since = sinceRaw;
      else if (/^-\d{1,4} (days?|hours?|minutes?)$/.test(sinceRaw)) since = sinceRaw;
      var sinceWhere = '';
      var sinceParams = [];
      if (since) {
        if (since.startsWith('-')) {
          sinceWhere = " WHERE created_at >= datetime('now', ?, 'localtime')";
          sinceParams = [since];
        } else {
          sinceWhere = " WHERE created_at >= ?";
          sinceParams = [since];
        }
      }

      var byContext = craDb.all(
        "SELECT context, model, COUNT(*) AS calls, " +
        "SUM(input_tokens) AS input_t, SUM(output_tokens) AS output_t, " +
        "SUM(cache_creation_tokens) AS cache_w, SUM(cache_read_tokens) AS cache_r, " +
        "ROUND(SUM(cost_usd), 4) AS cost_usd " +
        "FROM cra_llm_usage" + sinceWhere + " GROUP BY context, model ORDER BY cost_usd DESC",
        sinceParams
      );

      var totalsRow = craDb.get(
        "SELECT COUNT(*) AS calls, " +
        "SUM(input_tokens) AS input_t, SUM(output_tokens) AS output_t, " +
        "SUM(cache_read_tokens) AS cache_r, " +
        "ROUND(SUM(cost_usd), 4) AS cost_usd, " +
        "MIN(created_at) AS first_call, MAX(created_at) AS last_call " +
        "FROM cra_llm_usage" + sinceWhere,
        sinceParams
      );

      // Cache-Hit-Rate: cache_read vs (input + cache_read)
      var totalInput = (totalsRow && (totalsRow.input_t || 0)) + (totalsRow && (totalsRow.cache_r || 0));
      var hitRate = totalInput > 0 ? Math.round((totalsRow.cache_r || 0) / totalInput * 100) : 0;

      var daily = craDb.all(
        "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS calls, " +
        "ROUND(SUM(cost_usd), 4) AS cost_usd " +
        "FROM cra_llm_usage" + sinceWhere + " GROUP BY day ORDER BY day DESC LIMIT 14",
        sinceParams
      );

      return json(res, {
        totals: totalsRow || {},
        cache_hit_rate_pct: hitRate,
        by_context: byContext,
        daily: daily,
        note: 'Cost-Berechnung mit Haiku/Sonnet Standard-Tarif, Cache-Write=1.25x Input, Cache-Read=0.10x Input'
      });
    } catch (e) {
      return json(res, { error: String(e) }, 500);
    }
  }

  // Regeln abrufen (auch vom MCP-Server genutzt — Token ODER Session)
  if (url === '/api/cra/rules' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var rules = craRules.loadRules();
    return json(res, rules || { error: 'Regeln nicht ladbar' });
  }

  // ── Operations-Log (Token-Auth, kein Code-Diff) ───────────────
  if (url === '/api/cra/ops-log' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.action || !p.description) return json(res, { error: 'action und description sind Pflicht' });
        craDb.run(
          'INSERT INTO hook_events (hook_name, event_type, command, repo_name, details) VALUES (?,?,?,?,?)',
          ['ops-log', p.action, p.command || null, p.repo || null, p.description]
        );
        craDb.saveCraDb();
        console.log('[CRA/OpsLog]', p.action, '—', p.repo || '-', '—', p.description.substring(0, 80));
        json(res, { ok: true });
      } catch (e) { json(res, { error: e.message }); }
    });
  }

  // ── GitHub Webhook (HMAC-Auth, keine Session) ─────────────────
  if (url === '/api/cra/webhook' && req.method === 'POST') {
    return craAnalyzer.handleWebhook(req, res, { json: json, body: bodyFn });
  }

  // ── Manuelle Analyse triggern (Token-Auth) ────────────────────
  // -- CRA Session Handshake (von Claude Code bei Session-Start) --
  if (url === '/api/cra/session/start' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        var now = new Date();
        var sessionId = 'SES-CC-' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
        var repoName = p.repoName || '';
        var branch = p.branch || '';
        var hour24ago = new Date(now - 24*60*60*1000).toISOString().replace('T',' ').split('.')[0];

        // Pipeline Status
        var checkRules = require('./cra-rules').loadRules();
        var pipelineEnabled = !(checkRules && checkRules.pipeline && checkRules.pipeline.enabled === false);

        // Dispatcher Status
        var dispStatus = craDispatcher.getStatus();

        // Health berechnen
        var health = 'ok';
        if (dispStatus.circuit_breaker && dispStatus.circuit_breaker.tripped) health = 'critical';
        var stuckSessions = craDb.get(
          "SELECT COUNT(*) as cnt FROM dispatch_sessions WHERE status IN ('running','queued') AND last_heartbeat < ?",
          [new Date(now - 20*60*1000).toISOString().replace('T',' ').split('.')[0]]
        );
        if (stuckSessions && stuckSessions.cnt > 0) health = 'degraded';

        // Offene Findings (gesamt + für dieses Repo)
        var openFindings = craDb.get("SELECT COUNT(*) as cnt FROM findings WHERE status = 'open'");
        var repoFindings = [];
        if (repoName) {
          repoFindings = craDb.all(
            "SELECT id, title, severity, category FROM findings WHERE status = 'open' AND apps_json LIKE ? ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END LIMIT 10",
            ['%' + repoName + '%']
          );
        }

        // Hook-Erfolgsrate
        var rfcs24h = craDb.all(
          "SELECT diff_source, COUNT(*) as cnt FROM rfc_runs WHERE created_at > ? GROUP BY diff_source",
          [hour24ago]
        );
        var preCommits = rfcs24h.filter(function(r) { return r.diff_source === 'pre-commit'; })
          .reduce(function(s,r) { return s + r.cnt; }, 0);
        var postAudits = rfcs24h.filter(function(r) { return r.diff_source === 'post-commit-audit'; })
          .reduce(function(s,r) { return s + r.cnt; }, 0);
        var hookRate = (preCommits + postAudits) > 0
          ? Math.round(preCommits / (preCommits + postAudits) * 100) + '%' : '100%';

        // Letzter RFC für dieses Repo
        var lastRfc = repoName ? craDb.get(
          "SELECT id, overall_status, risk_score, created_at FROM rfc_runs WHERE app_name = ? ORDER BY created_at DESC LIMIT 1",
          [repoName]
        ) : null;

        // Blockierte RFCs für dieses Repo
        var blockedRfcs = repoName ? craDb.get(
          "SELECT COUNT(*) as cnt FROM rfc_runs WHERE app_name = ? AND overall_status = 'BLOCKED'",
          [repoName]
        ) : null;

        // Session in DB loggen
        craDb.run(
          "INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)",
          ['cra-session', 'session-start', repoName, sessionId,
           'Branch: ' + branch + ', CWD: ' + (p.workingDir || '') + ', PID: ' + (p.sessionPid || '')]
        );
        craDb.saveCraDb();

        console.log('[CRA/Session]', sessionId, 'gestartet —', repoName || '(kein Repo)', '/', branch || '-');

        json(res, {
          sessionId: sessionId,
          status: 'registered',
          pipeline_enabled: pipelineEnabled,
          health: health,
          fsc_active: dispStatus.fsc_active,
          circuit_breaker_tripped: !!(dispStatus.circuit_breaker && dispStatus.circuit_breaker.tripped),
          hook_success_rate: hookRate,
          findings: {
            open: (openFindings && openFindings.cnt) || 0
          },
          repo_findings: repoFindings,
          last_rfc: lastRfc ? (lastRfc.id + ' ' + lastRfc.overall_status + ' (Score ' + lastRfc.risk_score + ')') : null,
          blocked_rfcs: (blockedRfcs && blockedRfcs.cnt) || 0
        });
      } catch (e) {
        console.error('[CRA/Session] Fehler:', e.message);
        json(res, { error: e.message });
      }
    });
  }

  // -- CRA Health Dashboard (Token-Auth, kein Session noetig) --
  if (url === '/api/cra/health' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var now = new Date();
    var hour24ago = new Date(now - 24*60*60*1000).toISOString().replace('T',' ').split('.')[0];

    var rfcs24h = craDb.all(
      "SELECT diff_source, overall_status, COUNT(*) as cnt FROM rfc_runs WHERE created_at > ? GROUP BY diff_source, overall_status",
      [hour24ago]
    );
    var preCommits = rfcs24h.filter(function(r) { return r.diff_source === 'pre-commit'; })
      .reduce(function(s,r) { return s + r.cnt; }, 0);
    var postAudits = rfcs24h.filter(function(r) { return r.diff_source === 'post-commit-audit'; })
      .reduce(function(s,r) { return s + r.cnt; }, 0);
    var hookRate = (preCommits + postAudits) > 0
      ? Math.round(preCommits / (preCommits + postAudits) * 100) : 100;

    var dispStatus = craDispatcher.getStatus();
    var lastSession = craDb.get(
      "SELECT id, finding_id, status, started_at, completed_at FROM dispatch_sessions ORDER BY started_at DESC LIMIT 1"
    );
    var openFindings = craDb.get("SELECT COUNT(*) as cnt FROM findings WHERE status = 'open'");
    var deferredFindings = craDb.get("SELECT COUNT(*) as cnt FROM findings WHERE status = 'deferred'");

    var cutoff20 = new Date(now - 20*60*1000).toISOString().replace('T',' ').split('.')[0];
    var stuckSessions = craDb.get(
      "SELECT COUNT(*) as cnt FROM dispatch_sessions WHERE status IN ('running','queued') AND last_heartbeat < ?", [cutoff20]
    );
    var stuckTasks = craDb.get(
      "SELECT COUNT(*) as cnt FROM claude_tasks WHERE status = 'picked' AND created_at < ?",
      [new Date(now - 30*60*1000).toISOString().replace('T',' ').split('.')[0]]
    );
    var cbEvents = craDb.get(
      "SELECT COUNT(*) as cnt FROM hook_events WHERE event_type LIKE '%circuit%' AND created_at > ?", [hour24ago]
    );

    var health = {
      status: 'ok', timestamp: now.toISOString(),
      pipeline_enabled: !!(dispStatus.autostart),
      hooks: { pre_commit_rfcs_24h: preCommits, post_audit_rfcs_24h: postAudits,
        hook_success_rate: hookRate + '%', total_rfcs_24h: rfcs24h.reduce(function(s,r){return s+r.cnt;},0) },
      dispatcher: { running: dispStatus.running, circuit_breaker: dispStatus.circuit_breaker,
        fsc_active: dispStatus.fsc_active, fsc_window: dispStatus.fsc_window,
        active_session: dispStatus.active_session ? {id:dispStatus.active_session.id,status:dispStatus.active_session.status} : null,
        sessions_today: dispStatus.sessions_today },
      worker: { last_session: lastSession,
        stuck_sessions: (stuckSessions && stuckSessions.cnt) || 0,
        stuck_tasks: (stuckTasks && stuckTasks.cnt) || 0 },
      findings: { open: (openFindings && openFindings.cnt) || 0,
        deferred: (deferredFindings && deferredFindings.cnt) || 0 },
      circuit_breaker_events_24h: (cbEvents && cbEvents.cnt) || 0
    };
    if (health.worker.stuck_sessions > 0 || health.worker.stuck_tasks > 0) health.status = 'degraded';
    if (health.dispatcher.circuit_breaker && health.dispatcher.circuit_breaker.tripped) health.status = 'critical';
    return json(res, health);
  }

  if (url === '/api/cra/analyze' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        var result = craAnalyzer.runAnalysis({
          repoPath: p.repoPath,
          repoName: p.repoName,
          repoFullName: p.repoFullName,
          commitSha: p.commitSha || 'HEAD',
          parentSha: p.parentSha,
          commitMessage: p.commitMessage,
          branch: p.branch,
          title: p.title,
          diffSource: p.diffSource || 'manual',
          diff: p.diff
        });
        // Optional: GitHub Status-Checks fuer CI-Use-Case (z.B. PR mit rebased
        // SHA nach `gh pr update-branch`, wenn der GitHub-Push-Webhook nicht
        // gefeuert hat). Caller muss explizit opt-in mit echtem commitSha +
        // repoFullName; ohne diese Felder no-op (Pre-Commit-Hook unveraendert).
        if (p.postGithubStatus === true && p.repoFullName && p.commitSha && p.commitSha !== 'HEAD' && result) {
          githubStatus.postFromAnalysis({
            repoFullName: p.repoFullName,
            sha: p.commitSha,
            result: result
          }).catch(function(e) {
            console.warn('[CRA/Analyze] postFromAnalysis fehlgeschlagen:', e && e.message);
          });
          githubStatus.post2ndPassInitial({
            repoFullName: p.repoFullName,
            sha: p.commitSha,
            result: result
          }).catch(function(e) {
            console.warn('[CRA/Analyze] post2ndPassInitial fehlgeschlagen:', e && e.message);
          });
        }
        json(res, result || { error: 'Keine relevanten Änderungen' });
      } catch (e) {
        json(res, { error: e.message });
      }
    });
  }

  // ── Prod-Gate: Check ob Deploy freigegeben (Token ODER Session) ──
  if (url.indexOf('/api/cra/prod-check/') === 0 && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var checkRepo = decodeURIComponent(url.substring('/api/cra/prod-check/'.length));

    // Kill Switch?
    var checkRules = craRules.loadRules();
    if (checkRules && checkRules.pipeline && checkRules.pipeline.enabled === false) {
      return json(res, { allowed: true, reason: 'CRA deaktiviert (Kill Switch)', repo: checkRepo });
    }

    // Gültige Freigabe vorhanden?
    var ttl = (checkRules && checkRules.pipeline && checkRules.pipeline.approval_ttl_min) || 30;
    // expires_at wird beim Approval als ISO-UTC-String gespeichert (Line ~1887:
    // `new Date(...).toISOString()`). Vergleich daher gegen UTC-Now, NICHT
    // localtime — sonst wäre die Approval auf CEST-Server scheinbar 2h zu früh
    // expired (Vorfall 2026-05-10 PR #437/#446 deploy-blockiert trotz valider
    // 30min-Approval).
    var approval = craDb.get(
      "SELECT * FROM approvals WHERE repo_name = ? AND datetime(expires_at) > datetime('now') ORDER BY created_at DESC LIMIT 1",
      [checkRepo]
    );
    if (approval) {
      return json(res, { allowed: true, reason: 'Freigabe durch ' + approval.approved_by, rfcId: approval.rfc_id, repo: checkRepo, approval: approval });
    }

    // Letzter RFC für dieses Repo
    var lastRfc = craDb.get(
      "SELECT * FROM rfc_runs WHERE app_name = ? ORDER BY created_at DESC LIMIT 1",
      [checkRepo]
    );
    if (!lastRfc) {
      return json(res, { allowed: true, reason: 'Keine CRA-Analyse vorhanden', repo: checkRepo });
    }
    if (lastRfc.overall_status === 'APPROVED' || lastRfc.overall_status === 'OVERRIDDEN' || lastRfc.overall_status === 'SUPERSEDED') {
      return json(res, { allowed: true, reason: 'CRA-Analyse: ' + lastRfc.overall_status, rfcId: lastRfc.id, riskScore: lastRfc.risk_score, repo: checkRepo });
    }

    // BLOCKED/REJECTED — Admin muss freigeben
    return json(res, {
      allowed: false,
      reason: 'CRA-Analyse: BLOCKED (Score ' + lastRfc.risk_score + '). Admin-Freigabe erforderlich.',
      rfcId: lastRfc.id,
      riskScore: lastRfc.risk_score,
      riskLevel: lastRfc.risk_level,
      repo: checkRepo,
      approveUrl: '/cra#approve-' + lastRfc.id
    });
  }

  // ── Webhook-Status: Letzter Webhook-RFC fuer ein Repo ────────
  if (url.indexOf('/api/cra/webhook-status/') === 0 && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var wsRepo = decodeURIComponent(url.substring('/api/cra/webhook-status/'.length));
    var webhookRfc = craDb.get(
      "SELECT id, title, overall_status, risk_score, risk_level, findings_json, additions, deletions, created_at FROM rfc_runs WHERE app_name = ? AND diff_source = 'github-webhook' ORDER BY created_at DESC LIMIT 1",
      [wsRepo]
    );
    if (!webhookRfc) {
      return json(res, { found: false, repo: wsRepo });
    }
    var wFindings = [];
    try { wFindings = JSON.parse(webhookRfc.findings_json || '[]'); } catch(e) {}
    return json(res, {
      found: true,
      repo: wsRepo,
      rfcId: webhookRfc.id,
      status: webhookRfc.overall_status,
      riskScore: webhookRfc.risk_score,
      riskLevel: webhookRfc.risk_level,
      findings: wFindings,
      additions: webhookRfc.additions,
      deletions: webhookRfc.deletions,
      createdAt: webhookRfc.created_at
    });
  }

  // ── GitHub Checks Cache (Schritt 3+5) ─────────────────────────
  // GET /api/cra/checks/summary?rfcIds=A,B,C → batched summary (MUSS vor /checks/:owner/...)
  if (url === '/api/cra/checks/summary' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    // req.url enthaelt Query-String, url wurde bereits ge-splittet
    var qIdx = req.url.indexOf('?');
    var rfcIds = [];
    if (qIdx >= 0) {
      var params = new URLSearchParams(req.url.substring(qIdx + 1));
      var raw = params.get('rfcIds') || '';
      rfcIds = raw.split(',').map(function(s){ return s.trim(); }).filter(Boolean).slice(0, 200);
    }
    return json(res, githubChecks.getChecksSummaryForRfcs(rfcIds));
  }

  // GET /api/cra/checks-by-rfc/:rfcId → Checks + Pull-Info zu einem RFC
  if (url.indexOf('/api/cra/checks-by-rfc/') === 0 && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var rfcIdC = decodeURIComponent(url.substring('/api/cra/checks-by-rfc/'.length));
    var data = githubChecks.getChecksForRfc(rfcIdC);
    return json(res, data);
  }

  // ── Security Dashboard Aggregation (Schritt 6) ────────────────
  // GET /api/cra/security/repo-status → pro Repo: latest SHA + check counts + traffic_light
  if (url === '/api/cra/security/repo-status' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, githubChecks.getRepoStatusOverview());
  }

  // GET /api/cra/security/recent-failures?hours=24&limit=20
  if (url === '/api/cra/security/recent-failures' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var qIdx2 = req.url.indexOf('?');
    var hours = 24, limit = 20;
    if (qIdx2 >= 0) {
      var ps = new URLSearchParams(req.url.substring(qIdx2 + 1));
      hours = parseInt(ps.get('hours')) || 24;
      limit = parseInt(ps.get('limit')) || 20;
    }
    return json(res, githubChecks.getRecentFailures({ hours: hours, limit: limit }));
  }

  // GET /api/cra/security/stats → aggregierte Stats fuer Widgets
  if (url === '/api/cra/security/stats' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, githubChecks.getSecurityStats());
  }

  // GET /api/cra/qwen/health → Status der Qwen-Coding-Prep-Pipeline (Phase 0.6)
  if (url === '/api/cra/qwen/health' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    if (!qwenClient) return json(res, { reachable: false, error: 'qwen-client Plugin nicht installiert' }, 501);
    qwenClient.health().then(function(h) {
      json(res, h);
    }).catch(function(e) { json(res, { reachable: false, error: e.message }, 500); });
    return;
  }

  // ── Tool-Findings (Phase 1.1) ─────────────────────────────────
  // POST /api/cra/tool-findings/ingest → SARIF/JSON von Tool-Workflows einsammeln
  // Body: { repo_full_name, sha, tool?, payload }
  if (url === '/api/cra/tool-findings/ingest' && req.method === 'POST') {
    if (!tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        var result = toolFindings.ingest({
          repo_full_name: p.repo_full_name,
          sha: p.sha,
          tool: p.tool,
          payload: p.payload
        });
        return json(res, result, result.ok ? 200 : 400);
      } catch (e) { json(res, { error: e.message }, 400); }
    });
  }

  // GET /api/cra/tool-findings/stats → Aggregationen fuer Dashboard
  if (url === '/api/cra/tool-findings/stats' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, toolFindings.getStats());
  }

  // POST /api/cra/tool-findings/classify → Phase 1.2: manueller Trigger fuer Qwen+Haiku Klassifikation
  // Sonst laeuft das per Cron in server.js (alle 15 min, CET)
  if (url === '/api/cra/tool-findings/classify' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    toolFindingsClassifier.classifyOpenFindings({ maxBatches: 5 }).then(function(r) {
      json(res, r, r.ok ? 200 : 500);
    }).catch(function(e) { json(res, { ok: false, error: e.message }, 500); });
    return;
  }

  // GET /api/cra/llm-review/stats → Phase 2.1 Stats fuer Dashboard
  if (url === '/api/cra/llm-review/stats' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, rfcLlmReview.getReviewStats());
  }

  // GET /api/cra/llm-review/2nd-pass/stats → Phase 4 Option D 2nd-Pass Stats
  if (url === '/api/cra/llm-review/2nd-pass/stats' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, rfcLlmReview.get2ndPassStats());
  }

  // POST /api/cra/llm-review/2nd-pass/run → Phase 4 manueller 2nd-Pass-Trigger
  if (url === '/api/cra/llm-review/2nd-pass/run' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    rfcLlmReview.review2ndPassPending({ maxRfcs: 5 }).then(function(r) {
      json(res, r);
    }).catch(function(e) { json(res, { ok: false, error: e.message }, 500); });
    return;
  }

  // POST /api/cra/llm-review/run → Phase 2.1 manueller Trigger
  if (url === '/api/cra/llm-review/run' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    rfcLlmReview.reviewPendingRfcs({ maxRfcs: 10 }).then(function(r) {
      json(res, r);
    }).catch(function(e) { json(res, { ok: false, error: e.message }, 500); });
    return;
  }

  // POST /api/cra/llm-review/:rfcId → Single RFC re-review
  if (url.indexOf('/api/cra/llm-review/') === 0 && req.method === 'POST' && url !== '/api/cra/llm-review/run') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var lrRfcId = decodeURIComponent(url.substring('/api/cra/llm-review/'.length));
    if (!/^RFC-[A-Z0-9-]+$/i.test(lrRfcId)) return json(res, { error: 'Ungueltige RFC-ID' }, 400);
    rfcLlmReview.reviewRfc(lrRfcId).then(function(r) {
      json(res, r, r.ok ? 200 : 400);
    }).catch(function(e) { json(res, { ok: false, error: e.message }, 500); });
    return;
  }

  // GET /api/cra/tool-findings/:owner/:repo/:sha → Findings fuer einen Commit
  if (url.indexOf('/api/cra/tool-findings/') === 0 && req.method === 'GET' && url !== '/api/cra/tool-findings/stats') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var tfRest = url.substring('/api/cra/tool-findings/'.length).split('/');
    if (tfRest.length < 3) return json(res, { error: 'Path muss owner/repo/sha enthalten' }, 400);
    var tfRepo = tfRest[0] + '/' + tfRest[1];
    var tfSha = tfRest.slice(2).join('/');
    var findings = toolFindings.getFindingsForSha(tfRepo, tfSha);
    return json(res, { repo: tfRepo, sha: tfSha, count: findings.length, findings: findings });
  }

  // GET /api/cra/dependabot/stats → Open-Alerts pro Severity + pro Repo (Phase 0.5)
  if (url === '/api/cra/dependabot/stats' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, githubChecks.getDependabotStats());
  }

  // POST /api/cra/dependabot/sync → manueller Trigger (sonst Cron 6h)
  if (url === '/api/cra/dependabot/sync' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    githubChecks.syncAllDependabotAlerts().then(function(results) {
      json(res, { ok: true, results: results });
    }).catch(function(e) { json(res, { error: e.message }, 500); });
    return;
  }

  // GET /api/cra/checks/:owner/:repo/:sha → alle gh_checks fuer einen SHA
  if (url.indexOf('/api/cra/checks/') === 0 && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var rest = url.substring('/api/cra/checks/'.length).split('/');
    if (rest.length < 3) return json(res, { error: 'Path muss owner/repo/sha enthalten' }, 400);
    var ghcRepo = rest[0] + '/' + rest[1];
    var ghcSha = rest.slice(2).join('/');
    var checks = githubChecks.getChecksForSha(ghcRepo, ghcSha);
    return json(res, { repo: ghcRepo, sha: ghcSha, count: checks.length, checks: checks });
  }

  // ── Claude Task Queue ─────────────────────────────────────────

  // Agent ruft pending Tasks ab
  if (url === '/api/cra/pending-tasks' && req.method === 'GET') {
    if (!tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var tasks = craDb.all(
      "SELECT t.id as task_id, t.finding_id, t.status, t.created_at, f.title, f.severity, f.description, f.fix, f.lesson, f.apps_json, f.source, f.category FROM claude_tasks t LEFT JOIN findings f ON t.finding_id = f.id WHERE t.status = 'pending' ORDER BY t.id ASC"
    );
    return json(res, tasks || []);
  }

  // Agent markiert Task als picked/done
  if (url === '/api/cra/task-status' && req.method === 'POST') {
    if (!tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.taskId || !p.status) return json(res, { error: 'taskId und status sind Pflicht' });
        if (p.status === 'picked') {
          craDb.run("UPDATE claude_tasks SET status = 'picked', picked_at = datetime('now','localtime') WHERE id = ?", [p.taskId]);
        } else if (p.status === 'done') {
          craDb.run("UPDATE claude_tasks SET status = 'done', completed_at = datetime('now','localtime') WHERE id = ?", [p.taskId]);
          // Finding optional als fixed markieren
          if (p.markFixed) {
            var task = craDb.get('SELECT finding_id FROM claude_tasks WHERE id = ?', [p.taskId]);
            if (task) craDb.run("UPDATE findings SET status = 'fixed', updated_at = datetime('now','localtime') WHERE id = ?", [task.finding_id]);
          }
        } else if (p.status === 'failed') {
          craDb.run("UPDATE claude_tasks SET status = 'failed', completed_at = datetime('now','localtime') WHERE id = ?", [p.taskId]);
        }
        craDb.saveCraDb();
        json(res, { ok: true });
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Dashboard sendet Finding als Task
  if (url === '/api/cra/claude-task' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.findingId) return json(res, { error: 'findingId ist Pflicht' });
        var f = craDb.get('SELECT * FROM findings WHERE id = ?', [p.findingId]);
        if (!f) return json(res, { error: 'Finding nicht gefunden: ' + p.findingId });

        // Task in Queue eintragen
        craDb.run(
          "INSERT INTO claude_tasks (finding_id, status, created_at) VALUES (?, 'pending', datetime('now','localtime'))",
          [f.id]
        );
        craDb.saveCraDb();
        var taskId = craDb.get('SELECT last_insert_rowid() as id').id;
        console.log('[CRA/Claude] Task #' + taskId + ' gequeued:', f.id, f.title);

        // Remote Trigger feuern
        var triggerId = process.env.CRA_CLAUDE_TRIGGER_ID;
        var apiKey = process.env.ANTHROPIC_API_KEY;
        if (!triggerId || !apiKey) {
          craDb.run(
            'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
            ['claude-task', 'task-queued', f.apps_json || null, f.id, 'Task #' + taskId + ' gequeued (kein Trigger)']
          );
          craDb.saveCraDb();
          return json(res, { ok: true, mode: 'queued', taskId: taskId, findingId: f.id });
        }

        var https = require('https');
        var triggerReq = https.request({
          hostname: 'api.anthropic.com',
          path: '/v1/code/triggers/' + triggerId + '/run',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': 2 }
        }, function(res2) {
          var data = '';
          res2.on('data', function(c) { data += c; });
          res2.on('end', function() {
            console.log('[CRA/Claude] Trigger gefeuert fuer Task #' + taskId + ':', f.id);
            craDb.run(
              'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
              ['claude-task', 'trigger-fired', f.apps_json || null, f.id, 'Task #' + taskId + ' → Trigger ' + triggerId]
            );
            craDb.saveCraDb();
            json(res, { ok: true, mode: 'triggered', taskId: taskId, findingId: f.id, triggerId: triggerId });
          });
        });
        triggerReq.on('error', function(e) {
          console.error('[CRA/Claude] Trigger fehlgeschlagen:', e.message);
          json(res, { ok: true, mode: 'queued-trigger-failed', taskId: taskId, findingId: f.id, error: e.message });
        });
        triggerReq.write('{}');
        triggerReq.end();
      } catch (e) {
        json(res, { error: String(e) });
      }
    });
  }

  // ── Findings Registry (Token ODER Session) ───────────────────

  if (url === '/api/cra/findings' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var findings = craDb.all('SELECT * FROM findings ORDER BY severity, created_at DESC');
    return json(res, findings);
  }

  if (url === '/api/cra/findings' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var f = JSON.parse(b);
        if (!f.id || !f.title) return json(res, { error: 'id und title sind Pflicht' });
        // sql.js kann kein undefined binden — alle Felder auf null normalisieren
        var v = function(x) { return x === undefined ? null : x; };
        craDb.run(
          "INSERT OR REPLACE INTO findings (id, source, severity, category, title, description, fix, lesson, apps_json, check_type, check_description, check_command, status, regression_verified, cycle, tenant, screenshot_url, llm_suggested_severity, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))",
          [f.id, v(f.source), v(f.severity), v(f.category), f.title, v(f.description),
           v(f.fix), v(f.lesson), f.apps_json ? JSON.stringify(f.apps_json) : null,
           v(f.check_type), v(f.check_description), v(f.check_command), f.status || 'open',
           f.regression_verified ? 1 : 0,
           v(f.cycle), v(f.tenant), v(f.screenshot_url), v(f.llm_suggested_severity)]
        );
        // Cycle-Counters live aktualisieren (idempotent durch INSERT OR REPLACE)
        if (f.cycle) {
          try {
            craDb.run(
              "INSERT OR IGNORE INTO cycles (name) VALUES (?)",
              [f.cycle]
            );
            craDb.run(
              "UPDATE cycles SET findings_count = (SELECT COUNT(*) FROM findings WHERE cycle = ?), critical_count = (SELECT COUNT(*) FROM findings WHERE cycle = ? AND severity = 'CRITICAL') WHERE name = ?",
              [f.cycle, f.cycle, f.cycle]
            );
          } catch (cycleErr) { /* Counter-Update nicht kritisch */ }
        }
        craDb.saveCraDb();
        json(res, { ok: true, id: f.id });
      } catch (e) {
        json(res, { error: String(e) });
      }
    });
  }

  // ── Persona-Tester Cycles (Token ODER Session) ────────────────

  // GET /api/cra/cycles → alle Cycles, neueste zuerst
  if (url === '/api/cra/cycles' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craDb.all('SELECT * FROM cycles ORDER BY id DESC LIMIT 50'));
  }

  // GET /api/cra/cycle/current → aktueller Open-Cycle (lazy-create wenn keiner offen)
  if (url === '/api/cra/cycle/current' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var current = craDb.get("SELECT * FROM cycles WHERE status = 'open' ORDER BY id DESC LIMIT 1");
    if (!current) {
      var lastId = (craDb.get('SELECT MAX(id) AS mx FROM cycles') || {}).mx || 0;
      var newName = 'beta-cycle-' + (lastId + 1);
      craDb.run('INSERT INTO cycles (name) VALUES (?)', [newName]);
      craDb.saveCraDb();
      current = craDb.get('SELECT * FROM cycles WHERE name = ?', [newName]);
    }
    return json(res, current);
  }

  // POST /api/cra/cycle/start → expliziter neuer Cycle (idempotent)
  if (url === '/api/cra/cycle/start' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var body = b ? JSON.parse(b) : {};
        var name = body.name;
        if (!name) {
          var lastId = (craDb.get('SELECT MAX(id) AS mx FROM cycles') || {}).mx || 0;
          name = 'beta-cycle-' + (lastId + 1);
        }
        craDb.run('INSERT OR IGNORE INTO cycles (name) VALUES (?)', [name]);
        craDb.saveCraDb();
        json(res, craDb.get('SELECT * FROM cycles WHERE name = ?', [name]));
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // GET /api/cra/findings/by-cycle/:name → Findings + Aggregat fuer einen Cycle
  if (url.indexOf('/api/cra/findings/by-cycle/') === 0 && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var cycleName = decodeURIComponent(url.substring('/api/cra/findings/by-cycle/'.length).split('?')[0]);
    var cycleRow = craDb.get('SELECT * FROM cycles WHERE name = ?', [cycleName]);
    if (!cycleRow) return json(res, { error: 'Cycle nicht gefunden' }, 404);
    var rows = craDb.all('SELECT * FROM findings WHERE cycle = ? ORDER BY severity, created_at DESC', [cycleName]);
    var bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    var bySource = {};
    var byTenant = {};
    rows.forEach(function(r) {
      if (bySeverity[r.severity] !== undefined) bySeverity[r.severity]++;
      bySource[r.source || 'unknown'] = (bySource[r.source || 'unknown'] || 0) + 1;
      if (r.tenant) byTenant[r.tenant] = (byTenant[r.tenant] || 0) + 1;
    });
    return json(res, { cycle: cycleRow, findings: rows, aggregates: { bySeverity: bySeverity, bySource: bySource, byTenant: byTenant } });
  }

  // POST /api/cra/cycle/:name/close-and-triage → Mo 06:00 Cron oder manuell
  if (url.indexOf('/api/cra/cycle/') === 0 && url.indexOf('/close-and-triage') > 0 && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var triageName = decodeURIComponent(url.substring('/api/cra/cycle/'.length).split('/')[0]);
    var cy = craDb.get('SELECT * FROM cycles WHERE name = ?', [triageName]);
    if (!cy) return json(res, { error: 'Cycle nicht gefunden' }, 404);
    if (cy.status === 'closed') return json(res, { error: 'Cycle bereits geschlossen' }, 409);

    var allFindings = craDb.all('SELECT * FROM findings WHERE cycle = ?', [triageName]);

    // Pattern-Detection: gruppiere nach normalisierter Title-Praefix (erste 60 Zeichen, lowercased)
    // 3+ ähnliche Findings → Auto-Claude-Task fuer den Pattern
    var patterns = {};
    allFindings.forEach(function(f) {
      var key = (f.title || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
      if (!patterns[key]) patterns[key] = { count: 0, severities: [], ids: [], examples: [] };
      patterns[key].count++;
      patterns[key].severities.push(f.severity);
      patterns[key].ids.push(f.id);
      if (patterns[key].examples.length < 3) patterns[key].examples.push({ id: f.id, title: f.title, description: f.description });
    });

    var autoTaskedPatterns = [];
    Object.keys(patterns).forEach(function(key) {
      var p = patterns[key];
      if (p.count >= 3) {
        // Top-Severity bestimmen
        var topSev = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].find(function(s) { return p.severities.indexOf(s) >= 0; }) || 'MEDIUM';
        // Pseudo-Finding fuer Pattern erzeugen + Claude-Task queuen
        var patternFindingId = 'pattern-' + triageName + '-' + Buffer.from(key).toString('base64').slice(0, 16).replace(/[^a-zA-Z0-9]/g, '');
        var patternTitle = '[Pattern x' + p.count + '] ' + p.examples[0].title;
        var patternDesc = 'Auto-detected Pattern in ' + triageName + ': ' + p.count + ' aehnliche Findings.\n\nBeispiele:\n' +
          p.examples.map(function(e) { return '- ' + e.id + ': ' + e.title; }).join('\n') +
          '\n\nFinding-IDs: ' + p.ids.join(', ');
        try {
          craDb.run(
            "INSERT OR REPLACE INTO findings (id, source, severity, category, title, description, status, cycle) VALUES (?,?,?,?,?,?,?,?)",
            [patternFindingId, 'persona-triage-pattern', topSev, 'beta-pattern', patternTitle, patternDesc, 'open', triageName]
          );
          craDb.run(
            "INSERT INTO claude_tasks (finding_id, status, created_at) VALUES (?, 'pending', datetime('now','localtime'))",
            [patternFindingId]
          );
          autoTaskedPatterns.push({ key: key, count: p.count, severity: topSev, finding_id: patternFindingId });
        } catch (taskErr) { /* einzelne Task-Erstellung darf nicht alles blocken */ }
      }
    });

    // Triage-Summary erzeugen
    var summary = {
      cycle: triageName,
      total_findings: allFindings.length,
      by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      by_source: {},
      patterns_detected: Object.keys(patterns).length,
      patterns_auto_tasked: autoTaskedPatterns.length,
      auto_tasked_patterns: autoTaskedPatterns
    };
    allFindings.forEach(function(f) {
      if (summary.by_severity[f.severity] !== undefined) summary.by_severity[f.severity]++;
      summary.by_source[f.source || 'unknown'] = (summary.by_source[f.source || 'unknown'] || 0) + 1;
    });

    // Cycle schliessen
    craDb.run(
      "UPDATE cycles SET status = 'closed', closed_at = datetime('now','localtime'), triage_summary_json = ?, findings_count = ?, critical_count = ? WHERE name = ?",
      [JSON.stringify(summary), summary.total_findings, summary.by_severity.CRITICAL, triageName]
    );

    // Auto-Open neuer Cycle
    var lastId = (craDb.get('SELECT MAX(id) AS mx FROM cycles') || {}).mx || 0;
    var nextName = 'beta-cycle-' + (lastId + 1);
    craDb.run('INSERT INTO cycles (name) VALUES (?)', [nextName]);

    craDb.saveCraDb();
    return json(res, { ok: true, closed: triageName, opened: nextName, summary: summary });
  }

  // ── Lern-Engine + Session-Logs (Token ODER Session) ───────────

  // Session-Log speichern
  if (url === '/api/cra/sessions/log' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try { json(res, craLearning.saveSessionLog(JSON.parse(b))); }
      catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Session-Logs abrufen
  if (url === '/api/cra/sessions/logs' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craLearning.getSessionLogs(50));
  }

  // Fix-Patterns
  if (url === '/api/cra/learning/patterns' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var patCat = (req.url.split('category=')[1] || '').split('&')[0] || null;
    return json(res, craLearning.getPatterns(patCat ? decodeURIComponent(patCat) : null));
  }

  // Pattern-Statistiken
  if (url === '/api/cra/learning/stats' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craLearning.getPatternStats());
  }

  // Instruction-Hints
  if (url === '/api/cra/learning/hints' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craLearning.getHints());
  }

  // Lern-Overview
  if (url === '/api/cra/learning/overview' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craLearning.getLearningOverview());
  }

  // Weekly Report
  if (url === '/api/cra/report/weekly' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craLearning.generateWeeklyReport());
  }

  // Rollback-Rate
  if (url === '/api/cra/learning/rollback-rate' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craLearning.getRollbackRate());
  }

  // ── Test-Orchestrierung (Token ODER Session) ──────────────────

  // Tests triggern
  if (url === '/api/cra/tests/trigger' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        json(res, craTestOrch.triggerTests({
          finding_id: p.finding_id, session_id: p.session_id,
          target: p.target || 'staging', test_types: p.test_types || ['unit'],
          triggered_by: p.triggered_by || 'manual'
        }));
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Job-Ergebnis abfragen
  if (url.indexOf('/api/cra/tests/job/') === 0 && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var testJobId = decodeURIComponent(url.substring('/api/cra/tests/job/'.length));
    var jobResult = craTestOrch.getJobResult(testJobId);
    return json(res, jobResult || { error: 'Job nicht gefunden' });
  }

  // Alle Test-Jobs
  if (url === '/api/cra/tests/jobs' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craTestOrch.getJobs(50));
  }

  // Deploy-Erlaubnis pruefen (basierend auf Tests)
  if (url === '/api/cra/tests/can-deploy' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var cdFinding = (req.url.split('finding_id=')[1] || '').split('&')[0];
    var cdTarget = (req.url.split('target=')[1] || '').split('&')[0] || 'staging';
    return json(res, craTestOrch.canDeploy(decodeURIComponent(cdFinding), decodeURIComponent(cdTarget)));
  }

  // Failure-Matrix
  if (url === '/api/cra/tests/failure-matrix' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craTestOrch.FAILURE_MATRIX);
  }

  // ── Eskalation (Token ODER Session) ──────────────────────────

  // Eskalation erstellen
  if (url === '/api/cra/escalate' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.trigger) return json(res, { error: 'trigger ist Pflicht' });
        json(res, craEscalation.escalate({
          trigger: p.trigger, finding_id: p.finding_id, session_id: p.session_id,
          severity: p.severity, context: p.context || {},
          recommended_action: p.recommended_action
        }));
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Eskalation bestaetigen
  if (url.indexOf('/api/cra/escalate/ack/') === 0 && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var ackId = decodeURIComponent(url.substring('/api/cra/escalate/ack/'.length));
    return json(res, craEscalation.acknowledge(ackId));
  }

  // Alle Eskalationen
  if (url === '/api/cra/escalations' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craEscalation.getAll(50));
  }

  // Offene Eskalationen
  if (url === '/api/cra/escalations/open' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craEscalation.getOpen());
  }

  // Eskalations-Routen
  if (url === '/api/cra/escalations/routes' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craEscalation.getRoutes());
  }

  // ── Deploy-Safety (Token ODER Session) ────────────────────────

  // Safety-Status (Circuit Breaker, letzte Events)
  if (url === '/api/cra/safety/status' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, deploySafety.getStatus());
  }

  // Prod-Deploy Queue: staging-verified Findings + Prod-Erlaubnis
  if (url === '/api/cra/prod-queue' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var verified = craDispatcher.getStagingVerifiedFindings();
    var canProd = craDispatcher.canDeployProd();
    return json(res, { findings: verified, can_deploy_prod: canProd });
  }

  // Finding-Status auf staging-verified setzen (nach Tests auf Staging)
  if (url === '/api/cra/staging-verified' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.finding_id) return json(res, { error: 'finding_id ist Pflicht' });
        var finding = craDb.get('SELECT * FROM findings WHERE id = ?', [p.finding_id]);
        if (!finding) return json(res, { error: 'Finding nicht gefunden' });
        if (finding.status !== 'fixed' && finding.status !== 'staging-deployed') {
          return json(res, { error: 'Finding muss Status fixed oder staging-deployed haben (aktuell: ' + finding.status + ')' });
        }
        var now = new Date().toISOString().replace('T', ' ').split('.')[0];
        craDb.run("UPDATE findings SET status = 'staging-verified', updated_at = ? WHERE id = ?", [now, p.finding_id]);

        // Auto-Versioning: Patch-Version der App hochzählen
        var apps = [];
        try {
          apps = JSON.parse(finding.apps_json || '[]');
          if (typeof apps === 'string') apps = JSON.parse(apps); // doppelt-escaped
        } catch(e) {}
        var appId = (Array.isArray(apps) && apps[0]) || '';
        var version = null;
        if (appId) {
          var rules = craRules.loadRules();
          var app = (rules.apps || []).find(function(a) { return a.id === appId; });
          if (app) {
            var curVer = app.version || '0.0.0';
            var parts = curVer.split('.').map(Number);
            parts[2] = (parts[2] || 0) + 1; // Patch bump
            version = parts.join('.');
            app.version = version;
            craRules.saveRules(rules);
          }
        }

        // Changelog-Eintrag
        craDb.run(
          'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
          ['release', 'staging-verified', appId, p.finding_id,
           (version ? 'v' + version + ' — ' : '') + (finding.title || p.finding_id)]
        );

        craDb.saveCraDb();
        console.log('[CRA/Prod] Finding staging-verified:', p.finding_id, version ? 'v' + version : '');
        json(res, { ok: true, finding_id: p.finding_id, status: 'staging-verified', version: version });
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Health-Check manuell ausfuehren
  if (url === '/api/cra/safety/health-check' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        var rules = craRules.loadRules();
        var app = (rules.app_catalog || []).find(function(a) { return a.id === p.app_id; });
        if (!app) return json(res, { error: 'App nicht gefunden: ' + p.app_id });
        deploySafety.postDeployHealthCheck(app, function(err, result) {
          json(res, result);
        });
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Manueller Rollback
  if (url === '/api/cra/safety/rollback' && req.method === 'POST') {
    if (!authed(req)) return json(res, { error: 'Nur Admin (Session-Auth)' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        var rules = craRules.loadRules();
        var app = (rules.app_catalog || []).find(function(a) { return a.id === p.app_id; });
        if (!app) return json(res, { error: 'App nicht gefunden' });
        if (!p.git_sha) return json(res, { error: 'git_sha ist Pflicht' });
        json(res, deploySafety.rollback(app, p.git_sha, p.reason || 'Manueller Rollback via Dashboard'));
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Safe-Deploy (vollstaendiger Flow: Backup → Deploy → Health → Rollback)
  if (url === '/api/cra/safety/deploy' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        var rules = craRules.loadRules();
        var app = (rules.app_catalog || []).find(function(a) { return a.id === p.app_id; });
        if (!app) return json(res, { error: 'App nicht gefunden' });
        deploySafety.safeDeploy(app, p.git_sha || null, function(err, result) {
          json(res, result);
        });
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // ── Dispatcher (Token ODER Session) ───────────────────────────

  // Dispatcher-Status
  if (url === '/api/cra/dispatcher/status' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craDispatcher.getStatus());
  }

  // Dispatcher starten
  if (url === '/api/cra/dispatcher/start' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craDispatcher.start());
  }

  // Dispatcher stoppen
  if (url === '/api/cra/dispatcher/stop' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craDispatcher.stop());
  }

  // Autostart Toggle
  if (url === '/api/cra/dispatcher/autostart' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        var rules = craRules.loadRules();
        if (!rules || !rules.auto_fsc) return json(res, { error: 'auto_fsc Config fehlt' });
        rules.auto_fsc.dispatcher_autostart = !!p.enabled;
        var saveResult = craRules.saveRules(rules);
        if (saveResult.ok) console.log('[CRA/Dispatcher] Autostart:', p.enabled ? 'AN' : 'AUS');
        json(res, { ok: saveResult.ok, dispatcher_autostart: !!p.enabled });
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Manueller Dispatch (einmalig, optional dry_run)
  if (url === '/api/cra/dispatcher/dispatch' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b || '{}');
        json(res, craDispatcher.dispatchNext({ dry_run: !!p.dry_run }));
      } catch (e) { json(res, craDispatcher.dispatchNext()); }
    });
  }

  // Cleanup (vom Worker aufgerufen: stuck Sessions + Tasks bereinigen)
  if (url === '/api/cra/dispatcher/cleanup' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    json(res, craDispatcher.runCleanup());
    return;
  }

  // ── Worker-API (Phase 2: atomares Pickup + Completion) ─────────

  // Worker holt naechsten Task — atomar: Task picked + Session running + Prompt generiert
  if (url === '/api/cra/worker/pick-task' && req.method === 'POST') {
    if (!tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craDispatcher.pickTask());
  }

  // Worker meldet Heartbeat
  if (url === '/api/cra/worker/heartbeat' && req.method === 'POST') {
    if (!tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.session_id) return json(res, { error: 'session_id ist Pflicht' });
        json(res, craDispatcher.heartbeat(p.session_id));
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Worker meldet Task-Ergebnis — atomar: Task + Session + Gates
  if (url === '/api/cra/worker/complete' && req.method === 'POST') {
    if (!tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.session_id || !p.task_id) return json(res, { error: 'session_id und task_id sind Pflicht' });
        json(res, craDispatcher.workerComplete(p.session_id, p.task_id, p.status || 'done', p.result, p.error));
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // ── Legacy Dispatcher-Endpoints (abwaertskompatibel) ──────────

  // Heartbeat (von Claude Code Session)
  if (url === '/api/cra/dispatcher/heartbeat' && req.method === 'POST') {
    if (!tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.session_id) return json(res, { error: 'session_id ist Pflicht' });
        json(res, craDispatcher.heartbeat(p.session_id));
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Session abschliessen (von Claude Code Session)
  if (url === '/api/cra/dispatcher/complete' && req.method === 'POST') {
    if (!tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.session_id) return json(res, { error: 'session_id ist Pflicht' });
        json(res, craDispatcher.completeSession(p.session_id, p.result || 'resolved', p.error || null));
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Session-History
  if (url === '/api/cra/dispatcher/sessions' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craDispatcher.getSessions(50));
  }

  // Daily Summary manuell generieren
  if (url === '/api/cra/dispatcher/summary' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var today = new Date().toISOString().split('T')[0];
    return json(res, craDispatcher.generateDailySummary(today));
  }

  // ── Review-Engine (Token ODER Session) ────────────────────────

  // Code-Review anfordern
  if (url === '/api/cra/review/request' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.diff) return json(res, { error: 'diff ist Pflicht' });
        craReview.evaluate({
          diff: p.diff,
          finding_id: p.finding_id || null,
          finding: p.finding || null,
          test_results: p.test_results || null
        }, function(err, result) {
          if (err) return json(res, { error: String(err) });
          json(res, result);
        });
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Review-History abrufen
  if (url === '/api/cra/review/history' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var reviews = craDb.all('SELECT * FROM review_requests ORDER BY created_at DESC LIMIT 50');
    return json(res, reviews);
  }

  // Review-History fuer ein Finding
  if (url.indexOf('/api/cra/review/finding/') === 0 && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var revFindingId = decodeURIComponent(url.substring('/api/cra/review/finding/'.length));
    var findingReviews = craDb.all('SELECT * FROM review_requests WHERE finding_id = ? ORDER BY created_at DESC', [revFindingId]);
    return json(res, findingReviews);
  }

  // ── FSC – Forward Schedule of Change (Token ODER Session) ─────

  // Aktuelles aktives Fenster (von Hooks + Dispatcher genutzt)
  if (url === '/api/cra/fsc/current' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    craFsc.refreshStatuses();
    var current = craFsc.getCurrent();
    var next = current ? null : craFsc.getNext();
    return json(res, { active: !!current, window: current, next: next });
  }

  // Deploy-Erlaubnis pruefen (von deploy-guard genutzt)
  if (url === '/api/cra/fsc/can-deploy' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var qTarget = (req.url.split('target=')[1] || '').split('&')[0] || 'staging';
    var qSev = (req.url.split('severity=')[1] || '').split('&')[0] || null;
    craFsc.refreshStatuses();
    return json(res, craFsc.canDeploy(decodeURIComponent(qTarget), qSev ? decodeURIComponent(qSev) : null));
  }

  // Alle Fenster auflisten
  if (url === '/api/cra/fsc/windows' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    craFsc.refreshStatuses();
    return json(res, craFsc.getAll({ limit: 50 }));
  }

  // Fenster erstellen
  if (url === '/api/cra/fsc/windows' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var data = JSON.parse(b);
        var result = craFsc.create(data);
        json(res, result);
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Fenster aktualisieren
  if (url.indexOf('/api/cra/fsc/windows/') === 0 && req.method === 'PUT') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var fscId = decodeURIComponent(url.substring('/api/cra/fsc/windows/'.length));
    return bodyFn(req).then(function(b) {
      try {
        var data = JSON.parse(b);
        var result = craFsc.update(fscId, data);
        json(res, result);
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Auto-FSC Config abrufen
  if (url === '/api/cra/fsc/auto-config' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craFsc.getAutoFscConfig());
  }

  // Test-Mode Toggle
  if (url === '/api/cra/fsc/test-mode' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        var rules = craRules.loadRules();
        if (!rules || !rules.auto_fsc) return json(res, { error: 'auto_fsc Config fehlt' });
        rules.auto_fsc.test_mode = !!p.enabled;
        var saveResult = craRules.saveRules(rules);
        if (saveResult.ok) {
          console.log('[CRA/FSC] Test-Mode:', p.enabled ? 'AN' : 'AUS');
          craDb.run('INSERT INTO hook_events (hook_name, event_type, details) VALUES (?,?,?)',
            ['test-mode', p.enabled ? 'enabled' : 'disabled', 'Test-Mode ' + (p.enabled ? 'aktiviert' : 'deaktiviert')]);
          craDb.saveCraDb();
        }
        json(res, { ok: saveResult.ok, test_mode: !!p.enabled });
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Schedule editieren
  if (url === '/api/cra/fsc/schedule-update' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        var rules = craRules.loadRules();
        if (!rules || !rules.auto_fsc || !rules.auto_fsc.schedules) return json(res, { error: 'Keine Schedules' });
        var sched = rules.auto_fsc.schedules[p.index];
        if (!sched) return json(res, { error: 'Schedule ' + p.index + ' nicht gefunden' });

        if (p.action === 'toggle') {
          sched.enabled = !sched.enabled;
        } else if (p.action === 'severity') {
          var sevs = sched.allowed_severities || [];
          if (p.checked) { if (sevs.indexOf(p.value) < 0) sevs.push(p.value); }
          else { sevs = sevs.filter(function(s) { return s !== p.value; }); }
          sched.allowed_severities = sevs;
        } else if (p.action === 'target') {
          var tgts = sched.allowed_targets || [];
          if (p.checked) { if (tgts.indexOf(p.value) < 0) tgts.push(p.value); }
          else { tgts = tgts.filter(function(t) { return t !== p.value; }); }
          sched.allowed_targets = tgts;
        } else if (p.action === 'max') {
          sched.max_findings = Math.max(1, Math.min(20, parseInt(p.checked) || 5));
        }

        var result = craRules.saveRules(rules);
        if (result.ok) console.log('[CRA/FSC] Schedule aktualisiert:', sched.name, p.action);
        json(res, result);
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Auto-FSC manuell triggern
  if (url === '/api/cra/fsc/auto-generate' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, craFsc.autoGenerate());
  }

  // Fenster abbrechen
  if (url.indexOf('/api/cra/fsc/windows/') === 0 && req.method === 'DELETE') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var fscDelId = decodeURIComponent(url.substring('/api/cra/fsc/windows/'.length));
    return json(res, craFsc.cancel(fscDelId));
  }

  // ── Dashboard-Statistiken (Token ODER Session) ────────────────
  if (url === '/api/cra/stats') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var today = new Date().toISOString().split('T')[0];
    var stats = {
      rfcs_today: (craDb.get("SELECT COUNT(*) as c FROM rfc_runs WHERE created_at >= ?", [today]) || {}).c || 0,
      rfcs_total: (craDb.get("SELECT COUNT(*) as c FROM rfc_runs") || {}).c || 0,
      rfcs_blocked: (craDb.get("SELECT COUNT(*) as c FROM rfc_runs WHERE overall_status = 'BLOCKED'") || {}).c || 0,
      rfcs_approved: (craDb.get("SELECT COUNT(*) as c FROM rfc_runs WHERE overall_status = 'APPROVED'") || {}).c || 0,
      avg_risk_score: (craDb.get("SELECT AVG(risk_score) as a FROM rfc_runs") || {}).a || 0,
      last_rfc: craDb.get("SELECT id, title, app_name, overall_status, risk_score, created_at FROM rfc_runs ORDER BY created_at DESC LIMIT 1"),
      hooks_today: (craDb.get("SELECT COUNT(*) as c FROM hook_events WHERE created_at >= ?", [today]) || {}).c || 0,
      hooks_blocked: (craDb.get("SELECT COUNT(*) as c FROM hook_events WHERE event_type LIKE '%block%'") || {}).c || 0,
      findings_open: (craDb.get("SELECT COUNT(*) as c FROM findings WHERE status = 'open'") || {}).c || 0,
      findings_fixed: (craDb.get("SELECT COUNT(*) as c FROM findings WHERE status = 'fixed'") || {}).c || 0,
    };
    var blockRate = stats.rfcs_total > 0 ? Math.round(stats.rfcs_blocked / stats.rfcs_total * 100) : 0;
    stats.block_rate_pct = blockRate;
    stats.avg_risk_score = Math.round(stats.avg_risk_score * 10) / 10;
    // Pipeline-Stats
    var llmStats = require('../lib/llm').getStats();
    stats.llm = llmStats;
    var reviewStats = craDb.get("SELECT COUNT(*) as total, AVG(review_duration_ms) as avg_ms FROM review_requests") || {};
    stats.reviews_total = reviewStats.total || 0;
    stats.reviews_avg_ms = Math.round(reviewStats.avg_ms || 0);
    craFsc.refreshStatuses();
    var fscCurrent = craFsc.getCurrent();
    var fscNext = fscCurrent ? null : craFsc.getNext();
    stats.fsc_active = !!fscCurrent;
    stats.fsc_window = fscCurrent ? { id: fscCurrent.id, type: fscCurrent.type, ends_at: fscCurrent.ends_at } : null;
    stats.fsc_next = fscNext ? { id: fscNext.id, starts_at: fscNext.starts_at, type: fscNext.type } : null;
    return json(res, stats);
  }

  // ── Endpoints mit Dual-Auth (Token ODER Session) ──────────────

  // RFC-Details abrufen (Token ODER Session)
  if (url.indexOf('/api/cra/rfc-details/') === 0 && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var rfcDetailId = decodeURIComponent(url.substring('/api/cra/rfc-details/'.length));
    var rfcDetail = craDb.get('SELECT * FROM rfc_runs WHERE id = ?', [rfcDetailId]);
    if (!rfcDetail) return json(res, { error: 'RFC nicht gefunden' });
    return json(res, rfcDetail);
  }

  // Code Repository — Lesen (Token ODER Session)
  if (url === '/api/cra/code-repo' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var q = require('url').parse(req.url, true).query;
    var sql = 'SELECT * FROM code_repository';
    var params = [];
    if (q.tags) {
      sql += " WHERE tags_json LIKE ?";
      params.push('%' + q.tags + '%');
    } else if (q.repo) {
      sql += " WHERE repo = ?";
      params.push(q.repo);
    }
    sql += ' ORDER BY usage_count DESC, updated_at DESC LIMIT 100';
    return json(res, craDb.all(sql, params));
  }

  if (url === '/api/cra/code-repo/search' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var sq = require('url').parse(req.url, true).query;
    if (!sq.q) return json(res, []);
    var term = '%' + sq.q + '%';
    var results = craDb.all(
      "SELECT * FROM code_repository WHERE pattern_name LIKE ? OR description LIKE ? OR tags_json LIKE ? ORDER BY usage_count DESC LIMIT 50",
      [term, term, term]
    );
    return json(res, results);
  }

  // Code Repository — Schreiben (Token ODER Session)
  if (url === '/api/cra/code-repo' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.repo || !p.pattern_name) return json(res, { error: 'repo und pattern_name sind Pflicht' });
        var v = function(x) { return x === undefined ? null : x; };
        craDb.run(
          "INSERT INTO code_repository (repo, pattern_name, description, code_snippet, language, file_paths, tags_json, meta_json, created_by) VALUES (?,?,?,?,?,?,?,?,?)",
          [p.repo, p.pattern_name, v(p.description), v(p.code_snippet), p.language || 'javascript',
           v(p.file_paths), p.tags ? JSON.stringify(p.tags) : '[]',
           p.meta ? JSON.stringify(p.meta) : '{}', p.created_by || 'claude']
        );
        var lastId = craDb.get('SELECT last_insert_rowid() as id');
        craDb.saveCraDb();
        console.log('[CRA/CodeRepo] Pattern gespeichert:', p.pattern_name, 'Repo:', p.repo, 'ID:', lastId ? lastId.id : '?');
        json(res, { ok: true, id: lastId ? lastId.id : null });
      } catch (e) {
        json(res, { error: String(e) });
      }
    });
  }

  // ── Codebase-Zugriff (Read-Only, Token ODER Session) ───────────
  if (url.indexOf('/api/cra/source/') === 0 && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var sourcePath = decodeURIComponent(url.substring('/api/cra/source/'.length));
    var parts = sourcePath.split('/');
    var appId = parts[0];
    var filePath = parts.slice(1).join('/');

    // App-Verzeichnis aus rules.json
    var rules = craRules.loadRules();
    var app = (rules.apps || []).find(function(a) { return a.id === appId; });
    if (!app) return json(res, { error: 'App nicht gefunden: ' + appId });

    var baseDir = app.staging_dir || app.prod_dir;
    if (!baseDir) return json(res, { error: 'Kein Verzeichnis fuer App: ' + appId });

    // Path-Traversal Schutz
    var path = require('path');
    var resolved = path.resolve(baseDir, filePath);
    if (!resolved.startsWith(path.resolve(baseDir))) {
      return json(res, { error: 'Path Traversal blocked' });
    }

    // Blockierte Pfade
    if (filePath.includes('node_modules') || filePath.includes('.git/')) {
      return json(res, { error: 'Verzeichnis blockiert' });
    }

    var fs = require('fs');
    try {
      var stat = fs.statSync(resolved);

      // Verzeichnislisting (keine Extension-Prüfung nötig)
      if (stat.isDirectory()) {
        var files = fs.readdirSync(resolved).filter(function(f) {
          return !f.startsWith('.') && f !== 'node_modules';
        }).slice(0, 100);
        return json(res, { type: 'directory', path: filePath || '/', files: files });
      }

      // Datei: Extension + .env Prüfung
      if (filePath.includes('.env') && !filePath.endsWith('.env.example')) {
        return json(res, { error: '.env Dateien sind blockiert (nur .env.example erlaubt)' });
      }
      var allowed = ['.js', '.json', '.ts', '.html', '.css', '.env.example', '.md', '.sh', '.sql', '.txt'];
      var ext = path.extname(resolved);
      if (!allowed.includes(ext) && !filePath.endsWith('.env.example')) {
        return json(res, { error: 'Dateityp nicht erlaubt: ' + ext });
      }
      if (stat.size > 500000) return json(res, { error: 'Datei zu gross (>500KB)' });

      var content = fs.readFileSync(resolved, 'utf8');
      return json(res, { type: 'file', path: filePath, size: stat.size, content: content });
    } catch (e) {
      return json(res, { error: 'Nicht gefunden: ' + filePath });
    }
  }

  // App-Liste aus Rules (Token ODER Session)
  if (url === '/api/cra/apps' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var rules = craRules.loadRules();
    return json(res, rules.apps || []);
  }

  // Post-Implementation Review: Nach Deploy automatisch verifizieren (Token ODER Session)
  if (url === '/api/cra/pir' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.finding_id) return json(res, { error: 'finding_id ist Pflicht' });
        var finding = craDb.get('SELECT * FROM findings WHERE id = ?', [p.finding_id]);
        if (!finding) return json(res, { error: 'Finding nicht gefunden' });

        var now = new Date().toISOString().replace('T', ' ').split('.')[0];
        var pirResult = { finding_id: p.finding_id, checks: [], passed: true };

        // 1. Review-Check
        var lastReview = craDb.get(
          "SELECT decision FROM review_requests WHERE finding_id = ? ORDER BY created_at DESC LIMIT 1",
          [p.finding_id]
        );
        pirResult.checks.push({
          gate: 'review',
          status: lastReview ? lastReview.decision : 'none',
          passed: !lastReview || lastReview.decision === 'approve'
        });

        // 2. Test-Check
        var lastTest = craDb.get(
          "SELECT status FROM test_jobs WHERE finding_id = ? ORDER BY started_at DESC LIMIT 1",
          [p.finding_id]
        );
        pirResult.checks.push({
          gate: 'tests',
          status: lastTest ? lastTest.status : 'none',
          passed: !lastTest || lastTest.status === 'pass'
        });

        // 3. Health-Check (wenn App bekannt)
        var apps = [];
        try { apps = JSON.parse(finding.apps_json || '[]'); } catch(e) {}
        var appId = (Array.isArray(apps) && apps[0]) || '';
        var rules = craRules.loadRules();
        var app = (rules.apps || []).find(function(a) { return a.id === appId; });
        if (app && app.staging) {
          pirResult.checks.push({
            gate: 'health',
            status: 'pending',
            domain: app.staging
          });
          // Async Health-Check
          deploySafety.postDeployHealthCheck(app, function(err, health) {
            pirResult.checks[2].status = health.healthy ? 'pass' : 'fail';
            pirResult.checks[2].passed = health.healthy;
            pirResult.checks[2].status_code = health.status_code;
          });
        }

        // PIR bestanden?
        pirResult.passed = pirResult.checks.every(function(c) { return c.passed !== false; });

        // Finding-Status aktualisieren
        if (pirResult.passed && finding.status === 'staging-deployed') {
          craDb.run("UPDATE findings SET status = 'fixed', updated_at = ? WHERE id = ?", [now, p.finding_id]);
          pirResult.new_status = 'fixed';
        } else if (pirResult.passed && finding.status === 'fixed') {
          craDb.run("UPDATE findings SET status = 'staging-verified', updated_at = ? WHERE id = ?", [now, p.finding_id]);
          pirResult.new_status = 'staging-verified';
        }

        // PIR loggen
        craDb.run(
          'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
          ['cra-pir', pirResult.passed ? 'pir-passed' : 'pir-failed', appId, p.finding_id,
           JSON.stringify(pirResult.checks)]
        );
        craDb.saveCraDb();

        json(res, pirResult);
      } catch (e) { json(res, { error: String(e) }); }
    });
  }

  // Gate-Status für Finding abfragen (Token ODER Session)
  if (url.indexOf('/api/cra/gates/') === 0 && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var gFindingId = decodeURIComponent(url.substring('/api/cra/gates/'.length));
    var gates = craDispatcher.checkGates ? craDispatcher.checkGates(gFindingId) : { error: 'checkGates not available' };
    return json(res, gates);
  }

  // Changelog: Release-History pro App (Token ODER Session)
  if (url.indexOf('/api/cra/changelog/') === 0 && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var clApp = decodeURIComponent(url.substring('/api/cra/changelog/'.length));
    var entries = craDb.all(
      "SELECT created_at, details FROM hook_events WHERE hook_name = 'release' AND repo_name = ? ORDER BY created_at DESC LIMIT 50",
      [clApp]
    );
    var rules = craRules.loadRules();
    var app = (rules.apps || []).find(function(a) { return a.id === clApp; });
    return json(res, {
      app: clApp,
      current_version: app ? (app.version || '0.0.0') : null,
      entries: entries.map(function(e) { return { date: e.created_at, description: e.details }; })
    });
  }

  // Impact-Analyse: Welche Apps sind von einem Change betroffen (Token ODER Session)
  if (url.indexOf('/api/cra/impact/') === 0 && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var impactApp = decodeURIComponent(url.substring('/api/cra/impact/'.length));
    var rules = craRules.loadRules();
    var apps = rules.apps || [];
    var app = apps.find(function(a) { return a.id === impactApp; });
    if (!app) return json(res, { error: 'App nicht gefunden: ' + impactApp });

    var impact = {
      app: impactApp,
      direct_dependents: app.depended_by || [],
      depends_on: app.depends_on || [],
      test_required: [],
      risk_level: 'LOW'
    };

    // Direkte Abhängige müssen mitgetestet werden
    impact.test_required = [impactApp].concat(impact.direct_dependents);

    // Transitive Abhängige (2. Ebene)
    (app.depended_by || []).forEach(function(depId) {
      var depApp = apps.find(function(a) { return a.id === depId; });
      if (depApp && depApp.depended_by) {
        depApp.depended_by.forEach(function(transId) {
          if (impact.test_required.indexOf(transId) < 0) {
            impact.test_required.push(transId);
          }
        });
      }
    });

    // Risk-Level basierend auf Abhängigkeiten
    if (impact.direct_dependents.length >= 4) impact.risk_level = 'CRITICAL';
    else if (impact.direct_dependents.length >= 2) impact.risk_level = 'HIGH';
    else if (impact.direct_dependents.length >= 1) impact.risk_level = 'MEDIUM';

    return json(res, impact);
  }

  // Dependency-Graph: Vollständiger Abhängigkeitsgraph (Token ODER Session)
  if (url === '/api/cra/dependencies' && req.method === 'GET') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var rules = craRules.loadRules();
    var graph = (rules.apps || []).map(function(a) {
      return {
        id: a.id,
        name: a.name,
        type: a.type || 'app',
        version: a.version || '0.0.0',
        depends_on: a.depends_on || [],
        depended_by: a.depended_by || []
      };
    });
    return json(res, graph);
  }

  // Cleanup-Routine (Token ODER Session)
  if (url === '/api/cra/cleanup' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    try {
      var cleanResult = craAnalyzer.runCleanup();
      json(res, { ok: true, cleaned: cleanResult });
    } catch (e) {
      json(res, { error: String(e) });
    }
    return;
  }

  // ── RFC einreichen (Token ODER Session) ────────────────────────
  if (url === '/api/cra/rfc-submit' && req.method === 'POST') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        if (!p.rfc_id) return json(res, { error: 'rfc_id ist Pflicht' });
        var rfc = craDb.get('SELECT * FROM rfc_runs WHERE id = ?', [p.rfc_id]);
        if (!rfc) return json(res, { error: 'RFC nicht gefunden: ' + p.rfc_id });
        if (p.mode === 'schedule') {
          var windowId = p.window_id;
          if (!windowId) return json(res, { error: 'window_id ist Pflicht bei mode=schedule' });
          var win = craDb.get('SELECT * FROM fsc_windows WHERE id = ?', [windowId]);
          if (!win) return json(res, { error: 'FSC-Fenster nicht gefunden' });
          var findingId = 'RFC-SUBMIT-' + rfc.id;
          if (!craDb.get('SELECT * FROM findings WHERE id = ?', [findingId])) {
            craDb.run("INSERT INTO findings (id, source, severity, category, title, description, apps_json, status) VALUES (?,?,?,?,?,?,?,?)",
              [findingId, 'rfc-submit', p.severity || 'medium', 'change-request', rfc.title || rfc.id,
               'RFC eingereicht: ' + rfc.id + ' (Score: ' + rfc.risk_score + ')', JSON.stringify([rfc.app_name || 'unknown']), 'open']);
          }
          craDb.run("INSERT INTO claude_tasks (finding_id, status, created_at) VALUES (?, 'pending', datetime('now','localtime'))", [findingId]);
          craDb.saveCraDb();
          console.log('[CRA/Submit] RFC geplant:', rfc.id, 'in Fenster:', windowId);
          json(res, { ok: true, mode: 'scheduled', rfc_id: rfc.id, window_id: windowId, finding_id: findingId });
        } else {
          var findingIdNow = 'RFC-SUBMIT-' + rfc.id;
          if (!craDb.get('SELECT * FROM findings WHERE id = ?', [findingIdNow])) {
            craDb.run("INSERT INTO findings (id, source, severity, category, title, description, apps_json, status) VALUES (?,?,?,?,?,?,?,?)",
              [findingIdNow, 'rfc-submit', p.severity || 'medium', 'change-request', rfc.title || rfc.id,
               'RFC sofort umsetzen: ' + rfc.id + ' (Score: ' + rfc.risk_score + ')', JSON.stringify([rfc.app_name || 'unknown']), 'open']);
          }
          craDb.run("INSERT INTO claude_tasks (finding_id, status, created_at) VALUES (?, 'pending', datetime('now','localtime'))", [findingIdNow]);
          craDb.saveCraDb();
          var dispResult = craDispatcher.dispatchNext();
          console.log('[CRA/Submit] RFC sofort:', rfc.id, 'Dispatch:', dispResult.status || 'triggered');
          json(res, { ok: true, mode: 'immediate', rfc_id: rfc.id, finding_id: findingIdNow, dispatch: dispResult });
        }
      } catch (e) {
        console.error('[CRA/Submit] Fehler:', String(e));
        json(res, { error: String(e) });
      }
    });
  }

  // Code Repository — Löschen (Token ODER Session)
  if (url.indexOf('/api/cra/code-repo/') === 0 && req.method === 'DELETE') {
    if (!tokenAuth(req) && !authed(req)) return json(res, { error: 'Unauthorized' }, 401);
    var codeId = parseInt(url.substring('/api/cra/code-repo/'.length));
    if (isNaN(codeId)) return json(res, { error: 'Ungueltige ID' });
    craDb.run('DELETE FROM code_repository WHERE id = ?', [codeId]);
    craDb.saveCraDb();
    return json(res, { ok: true });
  }

  // ── Override-geschuetzte Endpoints (Override-Token ODER Dashboard) ──

  // Prod-Gate: Admin Approve/Override
  if (url.indexOf('/api/cra/approve/') === 0 && req.method === 'POST') {
    var approveAuth = overrideAuth(req, authed);
    if (!approveAuth) return json(res, { error: 'Override nicht erlaubt. Benutze CRA_OVERRIDE_TOKEN oder Dashboard-Login.' }, 403);
    return bodyFn(req).then(function(b) {
      try {
        var rfcId = decodeURIComponent(url.substring('/api/cra/approve/'.length));
        var p = JSON.parse(b);
        var reason = (p.reason || '').trim();
        if (!reason || reason.length < 3) return json(res, { error: 'Grund ist Pflicht (min. 3 Zeichen)' });

        var rfc = craDb.get('SELECT * FROM rfc_runs WHERE id = ?', [rfcId]);
        if (!rfc) return json(res, { error: 'RFC nicht gefunden' });

        var rules = craRules.loadRules();
        var ttl = (rules && rules.pipeline && rules.pipeline.approval_ttl_min) || 30;
        var expiresAt = new Date(Date.now() + ttl * 60000).toISOString().replace('T', ' ').split('.')[0];

        var approvedBy = approveAuth === 'override-token' ? 'admin-cli' : 'admin-dashboard';

        // Approval speichern (inkl. branch fuer Override-Token-Mechanismus, Phase 0.3)
        craDb.run(
          'INSERT INTO approvals (rfc_id, repo_name, action, reason, risk_score, findings_count, approved_by, expires_at, branch) VALUES (?,?,?,?,?,?,?,?,?)',
          [rfcId, rfc.app_name || '', p.action || 'override', reason, rfc.risk_score || 0,
           rfc.findings_json ? JSON.parse(rfc.findings_json).length : 0, approvedBy, expiresAt, rfc.branch || null]
        );

        // RFC als OVERRIDDEN markieren
        craDb.run(
          "UPDATE rfc_runs SET overall_status = 'OVERRIDDEN', approved_by = ?, override_reason = ? WHERE id = ?",
          [approvedBy, reason, rfcId]
        );
        craDb.saveCraDb();

        // Hook-Event loggen
        craDb.run(
          'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
          ['prod-gate', 'admin-override', rfc.app_name, rfcId, 'Via: ' + approveAuth + ' | Score: ' + rfc.risk_score + ' | Grund: ' + reason]
        );
        craDb.saveCraDb();

        console.log('[CRA/ProdGate] OVERRIDE:', rfcId, '— Via:', approveAuth, '— Score:', rfc.risk_score, '— Grund:', reason);

        // GitHub Status Checks auf success updaten (fire-and-forget).
        // Quick-Fix 2026-05-11 (Memory feedback_cra_2nd_pass_manual_status_post):
        //   Override posted bisher nur cra/gate; cra/2nd-pass-review blieb stale
        //   wenn ADR-0029 Phase E (status_re_eval) noch nicht durchgelaufen war.
        //   Folge: PR-Merge blockiert trotz Dashboard-Override.
        //   Fix: nach Override BEIDE Contexts unconditionally re-posten.
        //
        // Optionale Body-Params force_commit_sha + force_repo_full_name erlauben
        // Dashboard-Recovery wenn RFC mit commit_sha='HEAD' (analyze-Endpoint)
        // oder repo_full_name=null gespeichert wurde.
        var refreshed = craDb.get('SELECT * FROM rfc_runs WHERE id = ?', [rfcId]);
        var postSha = (p.force_commit_sha && /^[a-f0-9]{40}$/i.test(p.force_commit_sha)) ? p.force_commit_sha
                    : (refreshed && refreshed.commit_sha && refreshed.commit_sha !== 'HEAD') ? refreshed.commit_sha
                    : null;
        var postRepo = (p.force_repo_full_name && /^[\w.-]+\/[\w.-]+$/.test(p.force_repo_full_name)) ? p.force_repo_full_name
                     : (refreshed && refreshed.repo_full_name) ? refreshed.repo_full_name
                     : null;

        if (postSha && postRepo) {
          // cra/gate (bestehender Flow, jetzt mit potentiellem Force-Override)
          githubStatus.postFromAnalysis({
            repoFullName: postRepo,
            sha: postSha,
            result: {
              rfcId: rfcId,
              overallStatus: 'OVERRIDDEN',
              riskScore: refreshed.risk_score,
              findings: refreshed.findings_json ? JSON.parse(refreshed.findings_json).length : 0
            }
          }).catch(function() {});

          // cra/2nd-pass-review (Quick-Fix 2026-05-11)
          // post2ndPassFinal liest commit_sha/repo_full_name aus rfc-Objekt;
          // bei Force-Params overlayen wir die Werte.
          var rfcForPost = Object.assign({}, refreshed, { commit_sha: postSha, repo_full_name: postRepo });
          githubStatus.post2ndPassFinal(rfcForPost).catch(function() {});
        }

        json(res, { ok: true, rfcId: rfcId, expiresAt: expiresAt, ttlMin: ttl, via: approveAuth, github_status_posted: !!(postSha && postRepo) });
      } catch (e) {
        json(res, { error: e.message });
      }
    });
  }


  // ── Bulk-Override: alle BLOCKED RFCs in einem Rutsch freigeben ────────────
  if (url === '/api/cra/bulk-override' && req.method === 'POST') {
    var bulkAuth = overrideAuth(req, authed);
    if (!bulkAuth) return json(res, { error: 'Override nicht erlaubt.' }, 403);
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        var reason = (p.reason || '').trim();
        if (!reason || reason.length < 3) return json(res, { error: 'Grund ist Pflicht (min. 3 Zeichen)' });

        var where = "overall_status = 'BLOCKED'";
        var sqlArgs = [];
        if (p.repo) { where += ' AND app_name = ?'; sqlArgs.push(p.repo); }
        if (p.before_date) { where += ' AND created_at < ?'; sqlArgs.push(p.before_date); }
        if (p.rfc_ids && Array.isArray(p.rfc_ids) && p.rfc_ids.length) {
          where += ' AND id IN (' + p.rfc_ids.map(function() { return '?'; }).join(',') + ')';
          p.rfc_ids.forEach(function(id) { sqlArgs.push(id); });
        }

        var rfcs = craDb.all('SELECT * FROM rfc_runs WHERE ' + where, sqlArgs);
        var approvedBy = bulkAuth === 'override-token' ? 'admin-cli' : 'admin-dashboard';
        var rules = craRules.loadRules();
        var ttl = (rules && rules.pipeline && rules.pipeline.approval_ttl_min) || 30;
        var expiresAt = new Date(Date.now() + ttl * 60000).toISOString().replace('T', ' ').split('.')[0];

        var count = 0;
        rfcs.forEach(function(rfc) {
          craDb.run(
            'INSERT INTO approvals (rfc_id, repo_name, action, reason, risk_score, findings_count, approved_by, expires_at, branch) VALUES (?,?,?,?,?,?,?,?,?)',
            [rfc.id, rfc.app_name || '', 'override', reason, rfc.risk_score || 0,
             rfc.findings_json ? JSON.parse(rfc.findings_json).length : 0, approvedBy, expiresAt, rfc.branch || null]
          );
          craDb.run(
            "UPDATE rfc_runs SET overall_status = 'OVERRIDDEN', approved_by = ?, override_reason = ? WHERE id = ?",
            [approvedBy, reason, rfc.id]
          );
          craDb.run(
            'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
            ['prod-gate', 'bulk-override', rfc.app_name, rfc.id,
             'Via: ' + bulkAuth + ' | Score: ' + rfc.risk_score + ' | Bulk: ' + reason]
          );
          count++;
        });
        craDb.saveCraDb();

        console.log('[CRA/BulkOverride]', count, 'RFCs freigegeben — Via:', bulkAuth, '— Grund:', reason);
        json(res, { ok: true, count: count, approvedBy: approvedBy });
      } catch(e) {
        json(res, { error: e.message });
      }
    });
  }

  // RFC ablehnen (REJECTED)
  if (url.indexOf('/api/cra/reject/') === 0 && req.method === 'POST') {
    var rejectAuth = overrideAuth(req, authed);
    if (!rejectAuth) return json(res, { error: 'Reject nicht erlaubt. Benutze CRA_OVERRIDE_TOKEN oder Dashboard-Login.' }, 403);
    return bodyFn(req).then(function(b) {
      try {
        var rfcId = decodeURIComponent(url.substring('/api/cra/reject/'.length));
        var p = JSON.parse(b);
        var reason = (p.reason || '').trim();
        if (!reason || reason.length < 3) return json(res, { error: 'Grund ist Pflicht (min. 3 Zeichen)' });

        var rfc = craDb.get('SELECT * FROM rfc_runs WHERE id = ?', [rfcId]);
        if (!rfc) return json(res, { error: 'RFC nicht gefunden' });

        var rejectedBy = rejectAuth === 'override-token' ? 'admin-cli' : 'admin-dashboard';

        craDb.run(
          "UPDATE rfc_runs SET overall_status = 'REJECTED', approved_by = ?, override_reason = ? WHERE id = ?",
          [rejectedBy, reason, rfcId]
        );
        craDb.run(
          'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
          ['prod-gate', 'admin-reject', rfc.app_name || null, rfcId, 'Via: ' + rejectAuth + ' | REJECTED — Grund: ' + reason]
        );
        craDb.saveCraDb();

        console.log('[CRA/ProdGate] REJECTED:', rfcId, '— Via:', rejectAuth, '— Grund:', reason);

        // GitHub Status Check auf failure (explizit abgelehnt)
        if (rfc.commit_sha && rfc.repo_full_name) {
          githubStatus.postFromAnalysis({
            repoFullName: rfc.repo_full_name,
            sha: rfc.commit_sha,
            result: {
              rfcId: rfcId,
              overallStatus: 'REJECTED',
              riskScore: rfc.risk_score,
              findings: rfc.findings_json ? JSON.parse(rfc.findings_json).length : 0
            }
          }).catch(function() {});
        }

        json(res, { ok: true, rfcId: rfcId, via: rejectAuth });
      } catch (e) {
        json(res, { error: String(e) });
      }
    });
  }

  // ── Nightworker API (Token ODER Session) ────────────────────────

  var nw = require('./cra-nightworker');

  if (url === '/api/cra/nightworker/status' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, nw.getStatus());
  }
  if (url === '/api/cra/nightworker/start' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    nw.start();
    return json(res, { ok: true, status: nw.getStatus() });
  }
  if (url === '/api/cra/nightworker/stop' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    nw.stop();
    return json(res, { ok: true, status: nw.getStatus() });
  }
  if (url === '/api/cra/nightworker/trigger' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    nw.nightRun({ force: true });
    return json(res, { ok: true, message: 'Nacht-Durchlauf gestartet (force mode)' });
  }
  if (url === '/api/cra/nightworker/last-run' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var nwLastRun = nw.getLastRun();
    if (!nwLastRun) return json(res, { run: null });
    return json(res, { run: nwLastRun, fixes: nw.getFixLog(nwLastRun.id) });
  }
  if (url === '/api/cra/nightworker/staged' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var nwStaged = craDb.all("SELECT * FROM findings WHERE status = 'staged' ORDER BY updated_at DESC") || [];
    return json(res, { findings: nwStaged });
  }

  // Enricher: Manuell Findings anreichern
  if (url === '/api/cra/enricher/trigger' && req.method === 'POST') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    try {
      var enricher = require('./cra-enricher');
      enricher.enrichFindings();
      return json(res, { ok: true, message: 'Enricher gestartet' });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }
  if (url === '/api/cra/enricher/status' && req.method === 'GET') {
    if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Unauthorized' }, 401);
    var openCount = (craDb.get("SELECT COUNT(*) as c FROM findings WHERE status = 'open'") || {}).c || 0;
    var needsEnrich = (craDb.get("SELECT COUNT(*) as c FROM findings WHERE status = 'open' AND (fix IS NULL OR length(fix) < 50)") || {}).c || 0;
    return json(res, { openFindings: openCount, needsEnrichment: needsEnrich, enricherHour: '22:00 CET' });
  }

  // ── Session-geschuetzte Endpoints (nur Dashboard) ─────────────

  if (!authed(req) && !tokenAuth(req)) return json(res, { error: 'Nicht angemeldet' }, 401);

  // RFC loeschen
  if (url.indexOf('/api/cra/rfc/') === 0 && req.method === 'DELETE') {
    var delId = decodeURIComponent(url.substring('/api/cra/rfc/'.length));
    if (delId.indexOf('..') >= 0) return json(res, { error: 'invalid' });
    var delRfc = craDb.get('SELECT * FROM rfc_runs WHERE id = ?', [delId]);
    if (!delRfc) return json(res, { error: 'RFC nicht gefunden' });

    craDb.run('DELETE FROM rfc_runs WHERE id = ?', [delId]);
    craDb.run('DELETE FROM approvals WHERE rfc_id = ?', [delId]);
    craDb.run(
      'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
      ['prod-gate', 'rfc-deleted', delRfc.app_name || null, delId, 'RFC geloescht: ' + (delRfc.title || delId)]
    );
    craDb.saveCraDb();

    console.log('[CRA/ProdGate] DELETED:', delId);
    return json(res, { ok: true });
  }

  // Letzte Approvals abrufen
  if (url === '/api/cra/approvals') {
    var approvals = craDb.all('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 50');
    return json(res, approvals);
  }

  // Regeln aktualisieren
  if (url === '/api/cra/rules' && req.method === 'PUT') {
    return bodyFn(req).then(function(b) {
      try {
        var rules = JSON.parse(b);
        var result = craRules.saveRules(rules);
        json(res, result);
      } catch (e) {
        json(res, { error: 'Ungueltige JSON-Daten' });
      }
    });
  }

  // RFC-Liste (Phase 2.3 erweitert: top_severity + branch + llm_review_status)
  if (url === '/api/cra/rfcs') {
    var limit = parseInt(req.url.split('limit=')[1]) || 50;
    // ADR-0029 Phase 2c: NEEDS_REVIEW sortiert oberhalb von APPROVED, BLOCKED bleibt
    // ganz oben (Eskalations-Wirkung). Innerhalb gleicher Priorität nach created_at DESC.
    // CASE-Werte: niedriger = höhere Priorität in ASC-Sort.
    var rows = craDb.all(
      "SELECT id, title, change_type, app_name, branch, risk_score, risk_level, overall_status, " +
      "       gate1_status, gate2_status, gate3_status, additions, deletions, created_at, " +
      "       findings_json, llm_review_status, llm_review_severity, " +
      "       llm_review_2nd_status, llm_review_2nd_severity, status_re_eval_reason " +
      "  FROM rfc_runs " +
      " ORDER BY CASE overall_status " +
      "            WHEN 'BLOCKED' THEN 1 " +
      "            WHEN 'NEEDS_REVIEW' THEN 2 " +
      "            WHEN 'PENDING' THEN 3 " +
      "            WHEN 'APPROVED' THEN 4 " +
      "            WHEN 'OVERRIDDEN' THEN 5 " +
      "            WHEN 'REJECTED' THEN 6 " +
      "            ELSE 9 " +
      "          END ASC, created_at DESC LIMIT ?",
      [limit]
    );
    var SEV_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
    rows.forEach(function(r) {
      // findings_count + top_severity aus findings_json (CRA-SELF-003 + Phase 2.3)
      var findings = [];
      try { findings = r.findings_json ? JSON.parse(r.findings_json) : []; } catch (e) {}
      r.findings_count = findings.length;
      r.top_severity = findings.reduce(function(top, f) {
        var rank = SEV_RANK[f.severity] || 0;
        return rank > (SEV_RANK[top] || 0) ? f.severity : top;
      }, null);
      // failed_gates: welche Gates haben FAILED (Phase 2.3 Sichtbarkeit)
      r.failed_gates = [];
      if (r.gate1_status === 'FAILED') r.failed_gates.push('gate1');
      if (r.gate2_status === 'FAILED') r.failed_gates.push('gate2');
      if (r.gate3_status === 'FAILED') r.failed_gates.push('gate3');
      delete r.findings_json;
    });
    return json(res, rows);
  }

  // RFC by Finding — letzter RFC der zu einem Finding gehoert
  if (url.indexOf('/api/cra/rfc-by-finding/') === 0 && req.method === 'GET') {
    var findingId = decodeURIComponent(url.substring('/api/cra/rfc-by-finding/'.length));
    if (findingId.indexOf('..') >= 0) return json(res, { error: 'invalid' });
    // Suche RFCs deren findings_json das Finding enthaelt
    var rfcRow = craDb.get(
      "SELECT id, title, overall_status, risk_score, app_name, created_at FROM rfc_runs WHERE findings_json LIKE ? ORDER BY created_at DESC LIMIT 1",
      ['%' + findingId + '%']
    );
    if (!rfcRow) {
      // Fallback: Finding-ID koennte als RFC-SUBMIT-<rfcId> verknuepft sein
      if (findingId.indexOf('RFC-SUBMIT-') === 0) {
        var linkedRfcId = findingId.substring('RFC-SUBMIT-'.length);
        rfcRow = craDb.get("SELECT id, title, overall_status, risk_score, app_name, created_at FROM rfc_runs WHERE id = ?", [linkedRfcId]);
      }
    }
    if (!rfcRow) {
      // Letzter Fallback: Finding-Apps mit RFC app_name matchen
      var finding = craDb.get("SELECT apps_json FROM findings WHERE id = ?", [findingId]);
      if (finding && finding.apps_json) {
        try {
          var apps = JSON.parse(finding.apps_json);
          if (apps.length > 0) {
            rfcRow = craDb.get(
              "SELECT id, title, overall_status, risk_score, app_name, created_at FROM rfc_runs WHERE app_name = ? ORDER BY created_at DESC LIMIT 1",
              [apps[0]]
            );
          }
        } catch(e) {}
      }
    }
    return json(res, rfcRow || { error: 'not found' });
  }

  // Einzelnes RFC
  if (url.indexOf('/api/cra/rfc/') === 0) {
    var rfcId = decodeURIComponent(url.substring('/api/cra/rfc/'.length));
    if (rfcId.indexOf('..') >= 0) return json(res, { error: 'invalid' });
    var row = craDb.get('SELECT * FROM rfc_runs WHERE id = ?', [rfcId]);
    return json(res, row || { error: 'not found' });
  }

  // Hook-Event-Log
  if (url === '/api/cra/hooks') {
    var limit2 = parseInt(req.url.split('limit=')[1]) || 100;
    var events = craDb.all(
      'SELECT * FROM hook_events ORDER BY created_at DESC LIMIT ?',
      [limit2]
    );
    return json(res, events);
  }

  // Test-Run-History
  if (url === '/api/cra/tests') {
    var tests = craDb.all(
      'SELECT * FROM test_runs ORDER BY created_at DESC LIMIT 50'
    );
    return json(res, tests);
  }

  // Monitor-Run-History
  if (url === '/api/cra/monitors') {
    var monitors = craDb.all(
      'SELECT * FROM monitor_runs ORDER BY created_at DESC LIMIT 50'
    );
    return json(res, monitors);
  }

  // Findings Registry — nach oben verschoben (Token ODER Session Auth)

  // App-Katalog (aus cra-rules.json)
  if (url === '/api/cra/apps') {
    var rules = craRules.loadRules();
    return json(res, rules && rules.app_catalog ? rules.app_catalog : []);
  }

  // Test-Suite auf Server ausfuehren
  if (url === '/api/cra/run-test' && req.method === 'POST') {
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        var rules = craRules.loadRules();
        if (!rules) return json(res, { error: 'Regeln nicht ladbar' });
        var suite = (rules.test_suites || []).find(function(t) { return t.id === p.suiteId; });
        if (!suite) return json(res, { error: 'Test-Suite nicht gefunden' });

        var target = p.target || 'production';
        var args = (suite.args || '').replace('{target}', target);
        var basePath = process.env.MERIDIAN_BASE_PATH || '/opt/ks-management';
        var scriptPath = require('path').resolve(basePath, suite.path);
        if (!scriptPath.startsWith(basePath)) return json(res, { error: 'Ungültiger Script-Pfad' });
        var child = require('child_process');

        console.log('[CRA/Test] Starte:', suite.name, target, scriptPath);
        var start = Date.now();
        var result = child.spawnSync('bash', [scriptPath, args], {
          encoding: 'utf8', timeout: 120000, cwd: basePath
        });
        var duration = Date.now() - start;
        var output = (result.stdout || '') + (result.stderr || '');
        var exitCode = result.status || 0;

        // Ergebnis parsen (Exit-Code = Anzahl Fehler)
        var total = suite.tests_count || 0;
        var failed = exitCode;
        var passed = Math.max(0, total - failed);

        // In DB speichern
        craDb.run(
          'INSERT INTO test_runs (suite_name, target, total_tests, passed, failed, duration_ms, output, triggered_by) VALUES (?,?,?,?,?,?,?,?)',
          [suite.name, target, total, passed, failed, duration, output.substring(0, 50000), 'cra-dashboard']
        );
        craDb.saveCraDb();

        console.log('[CRA/Test]', suite.name, ':', passed + '/' + total, failed > 0 ? '(' + failed + ' FAILED)' : 'ALL PASSED', duration + 'ms');
        json(res, { ok: true, suite: suite.name, total: total, passed: passed, failed: failed, duration: duration });
      } catch (e) {
        console.error('[CRA/Test] Fehler:', e.message);
        json(res, { error: e.message });
      }
    });
  }

  // Monitor-Run einfuegen (intern, von server.js nach Script-Laeufen)
  if (url === '/api/cra/monitor-run' && req.method === 'POST') {
    return bodyFn(req).then(function(b) {
      try {
        var p = JSON.parse(b);
        craDb.run(
          'INSERT INTO monitor_runs (script_name, status, summary, report_json, triggered_by) VALUES (?,?,?,?,?)',
          [p.script_name, p.status, p.summary, p.report_json ? JSON.stringify(p.report_json) : null, p.triggered_by || 'manual']
        );
        craDb.saveCraDb();
        json(res, { ok: true });
      } catch (e) {
        json(res, { error: e.message });
      }
    });
  }

  // ── Lights-Out + Watchdog (Phase 4 Auto-Recovery, 30.04.2026) ────
  // Token-Auth in den Modulen selbst (X-CRA-Token gegen process.env.CRA_API_TOKEN)
  if (url.indexOf('/api/cra/lights-out/') === 0 && req.method === 'POST') {
    if (!lightsOut) return json(res, { error: 'lights-out Plugin nicht installiert' }, 501);
    if (url === '/api/cra/lights-out/review-1st') return lightsOut.review1st(req, res);
    if (url === '/api/cra/lights-out/review-2nd') return lightsOut.review2nd(req, res);
    if (url === '/api/cra/lights-out/gtm-track')  return lightsOut.gtmTrack(req, res);
    if (url === '/api/cra/lights-out/drain-all')  return lightsOut.drainAll(req, res);
    if (url === '/api/cra/lights-out/preview')    return lightsOut.preview(req, res);
  }
  if (url === '/api/cra/watchdog/check' && req.method === 'POST') {
    return watchdog.checkAll(req, res);
  }
  if (url === '/api/cra/watchdog/status' && req.method === 'GET') {
    return watchdog.publicStatus(req, res); // public, kein Auth
  }
  if (url === '/api/cra/watchdog/history' && req.method === 'GET') {
    return watchdog.history(req, res);
  }

  return false; // nicht behandelt
}

/**
 * Markiert veraltete lokale Pre-Commit-RFCs als STALE.
 *
 * Hintergrund: Bei jedem `cra_analyze`-Aufruf (MCP oder pre-commit Hook) entsteht
 * ein RFC mit diff_source='local' und commit_sha='HEAD'. Wenn der Commit danach
 * NICHT stattfindet (weil CRA BLOCKED), bleibt das RFC ewig als BLOCKED stehen,
 * auch wenn der Code nie auf main gelandet ist. Diese Funktion markiert solche
 * Zombie-RFCs nach 2 Stunden als STALE.
 */
function markStaleLocalRfcs() {
  try {
    var result = craDb.run(
      "UPDATE rfc_runs SET overall_status = 'STALE', status_re_eval_reason = ? " +
      "WHERE overall_status = 'BLOCKED' " +
      "AND diff_source IN ('local', 'pre-commit') " +
      "AND (commit_sha = 'HEAD' OR commit_sha IS NULL OR commit_sha = '') " +
      "AND datetime(created_at) < datetime('now', 'localtime', '-2 hours')",
      ['Auto-STALE: Lokale Pre-Commit-Analyse ohne nachfolgenden Commit (>2h). Kein Code auf main gelandet.']
    );
    if (result.changes > 0) {
      console.log('[CRA/Lifecycle] ' + result.changes + ' lokale BLOCKED-RFC(s) als STALE markiert');
    }
    return result.changes;
  } catch (e) {
    console.error('[CRA/Lifecycle] Stale-Cleanup Fehler:', e.message);
    return 0;
  }
}

function runPeriodicCleanup() {
  markStaleLocalRfcs();
  try { craAnalyzer.runCleanup(); } catch (e) { console.error('[CRA/Periodic] Cleanup-Fehler:', e.message); }
}

module.exports = { craApi, initCra: craDb.initCraDb, markStaleLocalRfcs, runPeriodicCleanup };
