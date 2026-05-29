// admin/cra/tool-findings.js — Aggregation + UPSERT von Tool-Outputs (Phase 1.1)
//
// Frisst Outputs von Semgrep, Trivy, Gitleaks, ESLint, Dependabot. Persistiert in
// tool_findings (UNIQUE pro repo+sha+tool+rule_id+file+line).
//
// Klassifikation kommt in Phase 1.2 (Prep-Pipeline + Eskalation), schreibt
// ai_severity/ai_confidence/ai_reason/ai_suggested_fix in dieselbe Zeile.

var craDb = require('./cra-db');

// ── Parser: tool-spezifisch zu kanonischem Finding-Format ──────────────────
//
// Kanonisches Finding: { tool, rule_id, file_path, line_no, tool_severity, message, raw_json }
// Alle Parser geben Array<Finding>. Robust gegen leere/malformed Inputs.

// Semgrep JSON: { results: [{ check_id, path, start.line, extra.severity, extra.message, ... }] }
function parseSemgrep(json) {
  if (!json || !Array.isArray(json.results)) return [];
  return json.results.map(function(r) {
    return {
      tool: 'semgrep',
      rule_id: String(r.check_id || 'unknown'),
      file_path: String(r.path || ''),
      line_no: r.start && r.start.line ? r.start.line : 0,
      tool_severity: (r.extra && r.extra.severity) || 'INFO',
      message: (r.extra && r.extra.message ? String(r.extra.message) : '').substring(0, 500),
      raw_json: JSON.stringify({ check_id: r.check_id, path: r.path, start: r.start, end: r.end }).substring(0, 2000)
    };
  });
}

// Trivy JSON: { Results: [{ Target, Vulnerabilities: [{ VulnerabilityID, Severity, PkgName, ... }] }] }
function parseTrivy(json) {
  if (!json || !Array.isArray(json.Results)) return [];
  var out = [];
  json.Results.forEach(function(res) {
    var target = res.Target || '';
    if (Array.isArray(res.Vulnerabilities)) {
      res.Vulnerabilities.forEach(function(v) {
        out.push({
          tool: 'trivy',
          rule_id: String(v.VulnerabilityID || 'unknown'),
          file_path: target,
          line_no: 0,
          tool_severity: v.Severity || 'UNKNOWN',
          message: ((v.PkgName ? v.PkgName + ': ' : '') + (v.Title || v.Description || '')).substring(0, 500),
          raw_json: JSON.stringify({ id: v.VulnerabilityID, pkg: v.PkgName, ver: v.InstalledVersion, fix: v.FixedVersion }).substring(0, 2000)
        });
      });
    }
  });
  return out;
}

// Gitleaks JSON: Array<{ RuleID, File, StartLine, Description, Match, ... }>
function parseGitleaks(json) {
  if (!Array.isArray(json)) return [];
  return json.map(function(g) {
    return {
      tool: 'gitleaks',
      rule_id: String(g.RuleID || 'unknown'),
      file_path: String(g.File || ''),
      line_no: g.StartLine || 0,
      tool_severity: 'CRITICAL', // Gitleaks-Hits sind per Definition CRITICAL
      message: String(g.Description || g.Match || '').substring(0, 500),
      raw_json: JSON.stringify({ rule: g.RuleID, file: g.File, line: g.StartLine, secret: '<redacted>' }).substring(0, 2000)
    };
  });
}

// ESLint JSON: Array<{ filePath, messages: [{ ruleId, severity, line, message }] }>
function parseEslint(json) {
  if (!Array.isArray(json)) return [];
  var out = [];
  json.forEach(function(file) {
    if (Array.isArray(file.messages)) {
      file.messages.forEach(function(m) {
        out.push({
          tool: 'eslint',
          rule_id: String(m.ruleId || 'no-rule'),
          file_path: String(file.filePath || ''),
          line_no: m.line || 0,
          tool_severity: m.severity === 2 ? 'ERROR' : 'WARN',
          message: String(m.message || '').substring(0, 500),
          raw_json: JSON.stringify({ rule: m.ruleId, line: m.line, col: m.column }).substring(0, 2000)
        });
      });
    }
  });
  return out;
}

// Dependabot Alerts (vom GitHub API holen wir bereits via github-checks.syncDependabotForRepo —
// dieser Parser ist fuer den Fall, dass jemand das per POST direkt schickt).
function parseDependabot(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(function(a) {
    var pkg = a.security_vulnerability && a.security_vulnerability.package || {};
    var advisory = a.security_advisory || {};
    return {
      tool: 'dependabot',
      rule_id: String(advisory.ghsa_id || advisory.cve_id || ('alert-' + (a.number || ''))),
      file_path: pkg.ecosystem ? pkg.ecosystem + ':' + (pkg.name || '?') : (pkg.name || '?'),
      line_no: 0,
      tool_severity: advisory.severity || 'UNKNOWN',
      message: String(advisory.summary || '').substring(0, 500),
      raw_json: JSON.stringify({ alert: a.number, state: a.state, ghsa: advisory.ghsa_id, cve: advisory.cve_id }).substring(0, 2000)
    };
  });
}

// ── Auto-Detection: welcher Parser passt? ──────────────────────────────────
function detectAndParse(toolHint, payload) {
  var hint = (toolHint || '').toLowerCase();
  if (hint === 'semgrep' || (payload && Array.isArray(payload.results) && payload.errors !== undefined)) {
    return { tool: 'semgrep', findings: parseSemgrep(payload) };
  }
  if (hint === 'trivy' || (payload && Array.isArray(payload.Results) && payload.SchemaVersion !== undefined)) {
    return { tool: 'trivy', findings: parseTrivy(payload) };
  }
  if (hint === 'gitleaks' || (Array.isArray(payload) && payload[0] && payload[0].RuleID)) {
    return { tool: 'gitleaks', findings: parseGitleaks(payload) };
  }
  if (hint === 'eslint' || (Array.isArray(payload) && payload[0] && Array.isArray(payload[0].messages))) {
    return { tool: 'eslint', findings: parseEslint(payload) };
  }
  if (hint === 'dependabot' || (Array.isArray(payload) && payload[0] && payload[0].security_advisory)) {
    return { tool: 'dependabot', findings: parseDependabot(payload) };
  }
  return { tool: null, findings: [] };
}

// ── UPSERT (Phase 1.1): neue Findings einfuegen, bekannte refresh ──────────
function upsertFinding(repoFullName, sha, f) {
  craDb.run(
    `INSERT INTO tool_findings
       (repo_full_name, sha, tool, rule_id, file_path, line_no, tool_severity, message, raw_json, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?, datetime('now','localtime'))
     ON CONFLICT(repo_full_name, sha, tool, rule_id, file_path, line_no) DO UPDATE SET
       tool_severity = excluded.tool_severity,
       message = excluded.message,
       raw_json = excluded.raw_json,
       last_seen_at = datetime('now','localtime')`,
    [repoFullName, sha, f.tool, f.rule_id, f.file_path, f.line_no, f.tool_severity, f.message, f.raw_json]
  );
}

// Aggregations-Endpoint: nimmt {repo_full_name, sha, tool?, payload} entgegen
function ingest(opts) {
  if (!opts.repo_full_name || !opts.sha) {
    return { ok: false, error: 'repo_full_name + sha sind Pflicht' };
  }
  var parsed = detectAndParse(opts.tool, opts.payload);
  if (!parsed.tool) {
    return { ok: false, error: 'Unbekanntes Format — tool-Hint ergaenzen oder anderes Schema schicken' };
  }
  var imported = 0;
  parsed.findings.forEach(function(f) {
    try { upsertFinding(opts.repo_full_name, opts.sha, f); imported++; } catch (e) { /* skip broken */ }
  });
  try { craDb.saveCraDb(); } catch (e) {}
  // Audit-Trail
  try {
    craDb.run(
      'INSERT INTO hook_events (hook_name, event_type, repo_name, details) VALUES (?,?,?,?)',
      ['tool-findings', 'ingest', opts.repo_full_name,
       'sha=' + opts.sha.substring(0, 8) + ' tool=' + parsed.tool + ' imported=' + imported + '/' + parsed.findings.length]
    );
    craDb.saveCraDb();
  } catch (e) {}
  return { ok: true, tool: parsed.tool, imported: imported, total_in_payload: parsed.findings.length };
}

// ── Stats-API (Phase 1.1): einfache Aggregationen fuer Dashboard ───────────
function getStats() {
  var byStatus = craDb.all(
    "SELECT status, ai_severity, COUNT(*) as cnt FROM tool_findings GROUP BY status, ai_severity ORDER BY status, ai_severity"
  );
  var byRepo = craDb.all(
    "SELECT repo_full_name, tool, COUNT(*) as cnt FROM tool_findings WHERE status != 'resolved' GROUP BY repo_full_name, tool ORDER BY repo_full_name"
  );
  var unclassifiedCount = craDb.get(
    "SELECT COUNT(*) as cnt FROM tool_findings WHERE ai_severity IS NULL AND status = 'open'"
  );
  return {
    by_status: byStatus,
    by_repo: byRepo,
    unclassified: unclassifiedCount ? unclassifiedCount.cnt : 0
  };
}

function getFindingsForSha(repoFullName, sha) {
  return craDb.all(
    `SELECT id, tool, rule_id, file_path, line_no, tool_severity, message,
            ai_severity, ai_confidence, ai_reason, ai_suggested_fix, status
     FROM tool_findings
     WHERE repo_full_name = ? AND sha = ?
     ORDER BY
       CASE ai_severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
       CASE tool_severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'ERROR' THEN 3 ELSE 4 END,
       file_path, line_no`,
    [repoFullName, sha]
  );
}

module.exports = {
  ingest: ingest,
  getStats: getStats,
  getFindingsForSha: getFindingsForSha,
  // Parser exportiert fuer direkte Nutzung / Tests
  parseSemgrep: parseSemgrep,
  parseTrivy: parseTrivy,
  parseGitleaks: parseGitleaks,
  parseEslint: parseEslint,
  parseDependabot: parseDependabot
};
