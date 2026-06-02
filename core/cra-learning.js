// SPDX-License-Identifier: Apache-2.0
// admin/cra/cra-learning.js — Lern-Engine + Reporting (CommonJS)
// Fix-Patterns, Instruction-Hints, Session-Logs, Daily Summary
var craDb = require('./cra-db');

// ── Session-Log speichern ───────────────────────────────────────

function saveSessionLog(log) {
  if (!log || !log.session_id) return { ok: false, error: 'session_id ist Pflicht' };

  var logId = log.id || ('LOG-' + log.session_id);
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];

  // PII-Filter: keine personenbezogenen Daten in Logs
  var steps = sanitizeSteps(log.steps || []);

  craDb.run(
    "INSERT OR REPLACE INTO session_logs (id, session_id, finding_id, steps_json, finding_status, started_at, ended_at, duration_minutes) VALUES (?,?,?,?,?,?,?,?)",
    [logId, log.session_id, log.finding_id || null, JSON.stringify(steps),
     log.finding_status || null, log.started_at || now, log.ended_at || now,
     log.duration_minutes || 0]
  );
  craDb.saveCraDb();

  // Lernen aus dem Log
  learnFromSession(log);

  console.log('[CRA/Learning] Session-Log gespeichert:', logId);
  return { ok: true, log_id: logId };
}

// ── Aus Session lernen ──────────────────────────────────────────

function learnFromSession(log) {
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];

  // 1. Fix-Pattern speichern bei resolved
  if (log.finding_status === 'resolved' && log.finding_id) {
    var finding = craDb.get('SELECT * FROM findings WHERE id = ?', [log.finding_id]);
    var category = (finding && finding.category) || 'unknown';

    // Review-Iterationen zaehlen
    var reviews = craDb.get(
      "SELECT COUNT(*) as c FROM review_requests WHERE finding_id = ?",
      [log.finding_id]
    );

    craDb.run(
      "INSERT INTO fix_patterns (category, fix_pattern, review_iterations, duration_minutes, finding_id, created_at) VALUES (?,?,?,?,?,?)",
      [category, log.diff_summary || null, (reviews && reviews.c) || 0,
       log.duration_minutes || 0, log.finding_id, now]
    );
    console.log('[CRA/Learning] Fix-Pattern gespeichert:', category, log.finding_id);
  }

  // 2. STOP-Bedingungen → Instruction-Hints
  if (log.stop_triggered && log.stop_reason) {
    var finding2 = craDb.get('SELECT * FROM findings WHERE id = ?', [log.finding_id || '']);
    var category2 = (finding2 && finding2.category) || 'general';

    craDb.run(
      "INSERT INTO instruction_hints (category, stop_reason, hint, source_session, created_at) VALUES (?,?,?,?,?)",
      [category2, log.stop_reason,
       'STOP ausgeloest: ' + log.stop_reason + '. Instruction-Klarstellung noetig.',
       log.session_id || null, now]
    );
    console.log('[CRA/Learning] Instruction-Hint:', log.stop_reason);
  }

  // 3. Review-Kommentare → Finding-Template-Hints
  if (log.review_comments && log.review_comments.length > 0) {
    var finding3 = craDb.get('SELECT * FROM findings WHERE id = ?', [log.finding_id || '']);
    var category3 = (finding3 && finding3.category) || 'general';

    log.review_comments.forEach(function(comment) {
      // Nur substantielle Kommentare (>20 Zeichen)
      if (comment && comment.length > 20) {
        craDb.run(
          "INSERT INTO instruction_hints (category, stop_reason, hint, source_session, created_at) VALUES (?,?,?,?,?)",
          [category3, 'review_comment', sanitizeText(comment).substring(0, 500),
           log.session_id || null, now]
        );
      }
    });
  }

  craDb.saveCraDb();
}

// ── Fix-Patterns abfragen ───────────────────────────────────────

function getPatterns(category, limit) {
  if (category) {
    return craDb.all(
      'SELECT * FROM fix_patterns WHERE category = ? ORDER BY created_at DESC LIMIT ?',
      [category, limit || 20]
    );
  }
  return craDb.all('SELECT * FROM fix_patterns ORDER BY created_at DESC LIMIT ?', [limit || 50]);
}

// ── Pattern-Statistiken ─────────────────────────────────────────

function getPatternStats() {
  var categories = craDb.all(
    "SELECT category, COUNT(*) as count, AVG(review_iterations) as avg_iterations, AVG(duration_minutes) as avg_duration FROM fix_patterns GROUP BY category ORDER BY count DESC"
  );
  return categories.map(function(c) {
    return {
      category: c.category,
      count: c.count,
      avg_iterations: Math.round((c.avg_iterations || 0) * 10) / 10,
      avg_duration_min: Math.round(c.avg_duration || 0)
    };
  });
}

// ── Instruction-Hints abfragen ──────────────────────────────────

function getHints(category, limit) {
  if (category) {
    return craDb.all(
      'SELECT * FROM instruction_hints WHERE category = ? ORDER BY created_at DESC LIMIT ?',
      [category, limit || 20]
    );
  }
  return craDb.all('SELECT * FROM instruction_hints ORDER BY created_at DESC LIMIT ?', [limit || 50]);
}

// ── Session-Logs abfragen ───────────────────────────────────────

function getSessionLogs(limit) {
  return craDb.all('SELECT * FROM session_logs ORDER BY ended_at DESC LIMIT ?', [limit || 50]);
}

// ── Rollback-Rate ───────────────────────────────────────────────

function getRollbackRate() {
  var total = craDb.get("SELECT COUNT(*) as c FROM dispatch_sessions WHERE status IN ('completed','failed')");
  var rollbacks = craDb.get("SELECT COUNT(*) as c FROM dispatch_sessions WHERE result = 'rollback'");
  var totalCount = (total && total.c) || 0;
  var rollbackCount = (rollbacks && rollbacks.c) || 0;
  var rate = totalCount > 0 ? Math.round(rollbackCount / totalCount * 100) : 0;

  return {
    total_sessions: totalCount,
    rollbacks: rollbackCount,
    rate_percent: rate,
    alert: rate > 5
  };
}

// ── PII-Sanitierung (DSGVO) ────────────────────────────────────

function sanitizeText(text) {
  if (!text) return '';
  // Email-Adressen entfernen
  text = text.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');
  // Telefonnummern (deutsch)
  text = text.replace(/(?:\+49|0)[0-9\s/-]{8,15}/g, '[PHONE]');
  // IP-Adressen
  text = text.replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '[IP]');
  // IBAN
  text = text.replace(/[A-Z]{2}\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{0,2}/g, '[IBAN]');
  return text;
}

function sanitizeSteps(steps) {
  return steps.map(function(step) {
    var clean = {};
    for (var key in step) {
      if (typeof step[key] === 'string') {
        clean[key] = sanitizeText(step[key]);
      } else {
        clean[key] = step[key];
      }
    }
    return clean;
  });
}

// ── Aggregierte Lern-Daten ──────────────────────────────────────

function getLearningOverview() {
  return {
    fix_patterns: getPatternStats(),
    total_patterns: (craDb.get("SELECT COUNT(*) as c FROM fix_patterns") || {}).c || 0,
    total_hints: (craDb.get("SELECT COUNT(*) as c FROM instruction_hints") || {}).c || 0,
    total_session_logs: (craDb.get("SELECT COUNT(*) as c FROM session_logs") || {}).c || 0,
    rollback_rate: getRollbackRate(),
    top_stop_reasons: craDb.all(
      "SELECT stop_reason, COUNT(*) as count FROM instruction_hints WHERE stop_reason != 'review_comment' GROUP BY stop_reason ORDER BY count DESC LIMIT 5"
    )
  };
}

// ── Weekly Report ───────────────────────────────────────────────

function generateWeeklyReport() {
  var now = new Date();
  var weekAgo = new Date(now.getTime() - 7 * 86400000);
  var twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);
  var nowStr = now.toISOString().split('T')[0];
  var weekAgoStr = weekAgo.toISOString().split('T')[0];
  var twoWeeksAgoStr = twoWeeksAgo.toISOString().split('T')[0];

  // KW berechnen
  var oneJan = new Date(now.getFullYear(), 0, 1);
  var kw = Math.ceil(((now - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);

  // ── Findings nach Severity ──
  var findingsBySev = craDb.all(
    "SELECT severity, COUNT(*) as total, SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open, SUM(CASE WHEN status='fixed' THEN 1 ELSE 0 END) as fixed FROM findings GROUP BY severity ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END"
  );
  var findingsTotal = (craDb.get("SELECT COUNT(*) as c FROM findings") || {}).c || 0;
  var findingsOpen = (craDb.get("SELECT COUNT(*) as c FROM findings WHERE status='open'") || {}).c || 0;
  var findingsFixed = (craDb.get("SELECT COUNT(*) as c FROM findings WHERE status='fixed'") || {}).c || 0;
  var fixRate = findingsTotal > 0 ? Math.round(findingsFixed / findingsTotal * 100) : 0;

  // ── RFCs diese Woche vs letzte Woche ──
  var rfcsThisWeek = craDb.all("SELECT * FROM rfc_runs WHERE created_at >= ?", [weekAgoStr]);
  var rfcsLastWeek = craDb.all("SELECT * FROM rfc_runs WHERE created_at >= ? AND created_at < ?", [twoWeeksAgoStr, weekAgoStr]);
  var rfcsAll = craDb.all("SELECT * FROM rfc_runs");

  var thisApproved = rfcsThisWeek.filter(function(r) { return r.overall_status === 'APPROVED'; }).length;
  var thisBlocked = rfcsThisWeek.filter(function(r) { return r.overall_status === 'BLOCKED'; }).length;
  var lastApproved = rfcsLastWeek.filter(function(r) { return r.overall_status === 'APPROVED'; }).length;
  var lastBlocked = rfcsLastWeek.filter(function(r) { return r.overall_status === 'BLOCKED'; }).length;

  var thisBlockRate = rfcsThisWeek.length > 0 ? Math.round(thisBlocked / rfcsThisWeek.length * 100) : 0;
  var lastBlockRate = rfcsLastWeek.length > 0 ? Math.round(lastBlocked / rfcsLastWeek.length * 100) : 0;
  var blockRateDelta = thisBlockRate - lastBlockRate;

  var thisAvgScore = rfcsThisWeek.length > 0 ? Math.round(rfcsThisWeek.reduce(function(s, r) { return s + (r.risk_score || 0); }, 0) / rfcsThisWeek.length * 10) / 10 : 0;
  var lastAvgScore = rfcsLastWeek.length > 0 ? Math.round(rfcsLastWeek.reduce(function(s, r) { return s + (r.risk_score || 0); }, 0) / rfcsLastWeek.length * 10) / 10 : 0;
  var avgScoreDelta = Math.round((thisAvgScore - lastAvgScore) * 10) / 10;

  // ── Reviews ──
  var reviewsThisWeek = craDb.all("SELECT * FROM review_requests WHERE created_at >= ?", [weekAgoStr]);
  var revApprove = reviewsThisWeek.filter(function(r) { return r.decision === 'approve'; }).length;
  var revChanges = reviewsThisWeek.filter(function(r) { return r.decision === 'request_changes'; }).length;
  var revEscalate = reviewsThisWeek.filter(function(r) { return r.decision === 'escalate'; }).length;
  var avgReviewMs = reviewsThisWeek.length > 0 ? Math.round(reviewsThisWeek.reduce(function(s, r) { return s + (r.review_duration_ms || 0); }, 0) / reviewsThisWeek.length) : 0;

  // ── Tests ──
  var testsThisWeek = craDb.all("SELECT * FROM test_runs WHERE created_at >= ?", [weekAgoStr]);
  var testsPassed = testsThisWeek.filter(function(t) { return t.failed === 0; }).length;
  var testsFailed = testsThisWeek.filter(function(t) { return t.failed > 0; }).length;

  // ── Sessions ──
  var sessionsThisWeek = craDb.all("SELECT * FROM dispatch_sessions WHERE started_at >= ?", [weekAgoStr]);
  var sesCompleted = sessionsThisWeek.filter(function(s) { return s.status === 'completed'; }).length;
  var sesFailed = sessionsThisWeek.filter(function(s) { return s.status === 'failed'; }).length;

  // ── Eskalationen ──
  var escOpen = (craDb.get("SELECT COUNT(*) as c FROM escalations WHERE status='open'") || {}).c || 0;
  var escThisWeek = craDb.all("SELECT trigger_type, COUNT(*) as count FROM escalations WHERE created_at >= ? GROUP BY trigger_type", [weekAgoStr]);

  // ── FSC ──
  var fscUsed = (craDb.get("SELECT COUNT(*) as c FROM fsc_windows WHERE status IN ('active','closed') AND starts_at >= ?", [weekAgoStr]) || {}).c || 0;

  // ── Rollback Rate ──
  var rb = getRollbackRate();

  // ── Lern-Engine ──
  var patternsThisWeek = (craDb.get("SELECT COUNT(*) as c FROM fix_patterns WHERE created_at >= ?", [weekAgoStr]) || {}).c || 0;
  var hintsThisWeek = (craDb.get("SELECT COUNT(*) as c FROM instruction_hints WHERE created_at >= ?", [weekAgoStr]) || {}).c || 0;

  // ── Findings diese Woche gefixt ──
  var fixedThisWeek = (craDb.get("SELECT COUNT(*) as c FROM findings WHERE status='fixed' AND updated_at >= ?", [weekAgoStr]) || {}).c || 0;
  var fixedLastWeek = (craDb.get("SELECT COUNT(*) as c FROM findings WHERE status='fixed' AND updated_at >= ? AND updated_at < ?", [twoWeeksAgoStr, weekAgoStr]) || {}).c || 0;

  return {
    meta: {
      kw: kw,
      year: now.getFullYear(),
      period: weekAgoStr + ' bis ' + nowStr,
      generated_at: now.toISOString().replace('T', ' ').split('.')[0]
    },
    summary: {
      fix_rate_pct: fixRate,
      findings_total: findingsTotal,
      findings_open: findingsOpen,
      findings_fixed: findingsFixed,
      fixed_this_week: fixedThisWeek,
      fixed_last_week: fixedLastWeek,
      quality_trend: fixedThisWeek > fixedLastWeek ? 'improving' : (fixedThisWeek < fixedLastWeek ? 'declining' : 'stable')
    },
    findings_by_severity: findingsBySev,
    pipeline: {
      rfcs_this_week: rfcsThisWeek.length,
      rfcs_last_week: rfcsLastWeek.length,
      approved: thisApproved,
      blocked: thisBlocked,
      block_rate_pct: thisBlockRate,
      block_rate_delta: blockRateDelta,
      block_rate_trend: blockRateDelta < 0 ? 'improving' : (blockRateDelta > 0 ? 'worsening' : 'stable'),
      avg_risk_score: thisAvgScore,
      avg_score_delta: avgScoreDelta,
      score_trend: avgScoreDelta < 0 ? 'improving' : (avgScoreDelta > 0 ? 'worsening' : 'stable')
    },
    reviews: {
      total: reviewsThisWeek.length,
      approve: revApprove,
      request_changes: revChanges,
      escalate: revEscalate,
      avg_duration_ms: avgReviewMs
    },
    tests: {
      total: testsThisWeek.length,
      passed: testsPassed,
      failed: testsFailed,
      pass_rate_pct: testsThisWeek.length > 0 ? Math.round(testsPassed / testsThisWeek.length * 100) : 0
    },
    sessions: {
      total: sessionsThisWeek.length,
      completed: sesCompleted,
      failed: sesFailed
    },
    escalations: {
      open: escOpen,
      this_week: escThisWeek
    },
    fsc: {
      windows_used: fscUsed
    },
    rollback_rate: rb,
    learning: {
      patterns_this_week: patternsThisWeek,
      hints_this_week: hintsThisWeek
    }
  };
}

module.exports = {
  saveSessionLog: saveSessionLog,
  getPatterns: getPatterns,
  getPatternStats: getPatternStats,
  getHints: getHints,
  getSessionLogs: getSessionLogs,
  getRollbackRate: getRollbackRate,
  getLearningOverview: getLearningOverview,
  generateWeeklyReport: generateWeeklyReport,
  sanitizeText: sanitizeText
};
