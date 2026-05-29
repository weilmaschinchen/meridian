// admin/cra/cra-scanner.js — Statische Code-Scans + Finding-Erkennung (CommonJS)
// Grep-basiert, kein LLM. Läuft auf dem Server, scannt Staging-Repos.
var child = require('child_process');
var fs = require('fs');
var path = require('path');
var craDb = require('./cra-db');
var craRules = require('./cra-rules');

// ── Scan-Patterns (unabhängig von cra-rules.json, für Repo-weite Scans) ──

var CODE_PATTERNS = [
  // Security
  { id: 'NW-SEC-01', pattern: /eval\s*\(/, severity: 'HIGH', category: 'security', title: 'eval() Verwendung', fileTypes: ['js'] },
  { id: 'NW-SEC-02', pattern: /innerHTML\s*=/, severity: 'HIGH', category: 'security', title: 'innerHTML Zuweisung (XSS-Risiko)', fileTypes: ['js', 'html'] },
  { id: 'NW-SEC-03', pattern: /document\.write\s*\(/, severity: 'HIGH', category: 'security', title: 'document.write (XSS-Risiko)', fileTypes: ['js', 'html'] },
  { id: 'NW-SEC-04', pattern: /child_process.*exec\s*\(/, severity: 'CRITICAL', category: 'security', title: 'exec() ohne Whitelist', fileTypes: ['js'] },
  { id: 'NW-SEC-05', pattern: /\.query\s*\(\s*['"`].*\+\s*(?:req\.|params\.|body\.)/, severity: 'CRITICAL', category: 'security', title: 'SQL-Injection (String-Concat)', fileTypes: ['js'] },
  { id: 'NW-SEC-06', pattern: /(?:password|secret|api_key)\s*[:=]\s*['"][^${}][^'"]{8,}['"]/, severity: 'CRITICAL', category: 'secret', title: 'Hardcoded Secret/Password', fileTypes: ['js'] },
  // Auth
  { id: 'NW-AUTH-01', pattern: /app\.(get|post|put|delete)\s*\(\s*['"]\/api\/(?!health).*(?:(?!requireAuth|authed|tokenAuth).)*\{/, severity: 'MEDIUM', category: 'auth', title: 'API-Endpoint moeglicherweise ohne Auth', fileTypes: ['js'] },
  // Quality
  { id: 'NW-QUAL-01', pattern: /console\.log\s*\(.*(?:password|secret|token|api.?key)/i, severity: 'HIGH', category: 'quality', title: 'Sensitives Logging', fileTypes: ['js'] },
  { id: 'NW-QUAL-02', pattern: /TODO|FIXME|HACK|XXX/, severity: 'LOW', category: 'quality', title: 'TODO/FIXME im Code', fileTypes: ['js'] },
];

// ── Einen Repo-Ordner scannen ───────────────────────────────────────

function scanRepo(repoDir, appId) {
  if (!fs.existsSync(repoDir)) return [];
  var findings = [];

  CODE_PATTERNS.forEach(function(pat) {
    pat.fileTypes.forEach(function(ext) {
      try {
        // rg (ripgrep) fuer Performance, Fallback auf grep
        var cmd = 'rg -n --no-heading --glob "*.'+ext+'" --glob "!node_modules" --glob "!.git" '
          + JSON.stringify(pat.pattern.source) + ' ' + JSON.stringify(repoDir)
          + ' 2>/dev/null | head -20';
        var result = child.execSync(cmd, { encoding: 'utf8', timeout: 10000 });
        if (result && result.trim()) {
          var matches = result.trim().split('\n');
          findings.push({
            id: pat.id + '-' + appId,
            pattern_id: pat.id,
            severity: pat.severity,
            category: pat.category,
            title: pat.title + ' in ' + appId,
            description: matches.length + ' Treffer in ' + appId + ':\n' + matches.slice(0, 5).join('\n'),
            app: appId,
            match_count: matches.length,
            sample_files: matches.slice(0, 5).map(function(m) {
              return m.split(':')[0].replace(repoDir + '/', '');
            })
          });
        }
      } catch(e) { /* grep/rg nicht gefunden oder Timeout */ }
    });
  });

  return findings;
}

// ── npm audit (Dependency-Check) ────────────────────────────────────

function npmAudit(repoDir, appId) {
  if (!fs.existsSync(path.join(repoDir, 'package.json'))) return [];
  try {
    var result = child.execSync(
      'cd ' + JSON.stringify(repoDir) + ' && npm audit --json 2>/dev/null',
      { encoding: 'utf8', timeout: 30000 }
    );
    var audit = JSON.parse(result);
    var vulns = audit.vulnerabilities || {};
    var findings = [];
    var keys = Object.keys(vulns);
    for (var i = 0; i < Math.min(keys.length, 10); i++) {
      var v = vulns[keys[i]];
      if (v.severity === 'critical' || v.severity === 'high') {
        findings.push({
          id: 'NW-DEP-' + appId + '-' + keys[i],
          severity: v.severity === 'critical' ? 'CRITICAL' : 'HIGH',
          category: 'dependency',
          title: 'npm Vulnerability: ' + keys[i] + ' (' + v.severity + ')',
          description: (v.via || []).map(function(x) { return typeof x === 'string' ? x : (x.title || x.url || ''); }).join(', '),
          app: appId,
          fix_available: !!v.fixAvailable
        });
      }
    }
    return findings;
  } catch(e) {
    // npm audit gibt Exit-Code != 0 bei Findings → trotzdem parsen
    try {
      var stderr = e.stdout || '';
      if (stderr) {
        var audit2 = JSON.parse(stderr);
        // Gleiche Logik wie oben, vereinfacht
        var count = (audit2.metadata || {}).vulnerabilities || {};
        if ((count.critical || 0) + (count.high || 0) > 0) {
          return [{
            id: 'NW-DEP-' + appId + '-summary',
            severity: count.critical > 0 ? 'CRITICAL' : 'HIGH',
            category: 'dependency',
            title: appId + ': ' + (count.critical || 0) + ' critical, ' + (count.high || 0) + ' high npm vulns',
            description: 'npm audit fuer ' + appId,
            app: appId
          }];
        }
      }
    } catch(e2) { /* ignore parse errors */ }
    return [];
  }
}

// ── Findings in DB registrieren (dedup + regression) ────────────────

function registerFindings(findings) {
  var registered = 0;
  var regressed = 0;

  findings.forEach(function(f) {
    var existing = craDb.get('SELECT * FROM findings WHERE id = ?', [f.id]);

    if (existing) {
      // Regression: war gefixt, taucht wieder auf
      if (existing.status === 'fixed' || existing.status === 'staged') {
        craDb.run(
          "UPDATE findings SET status = 'open', description = ?, updated_at = datetime('now','localtime') WHERE id = ?",
          ['REGRESSION: ' + f.description, f.id]
        );
        regressed++;
        console.log('[CRA/Scanner] REGRESSION:', f.id, f.title);
      }
      // Sonst: Finding existiert schon, nichts tun
      return;
    }

    // Neues Finding
    craDb.run(
      'INSERT INTO findings (id, source, severity, category, title, description, apps_json, status) VALUES (?,?,?,?,?,?,?,?)',
      [f.id, 'nightworker-scan', f.severity, f.category, f.title, f.description,
       JSON.stringify(f.app ? [f.app] : []), 'open']
    );
    registered++;
  });

  if (registered > 0 || regressed > 0) {
    craDb.saveCraDb();
    console.log('[CRA/Scanner] Registriert:', registered, 'neu,', regressed, 'Regressionen');
  }

  return { registered: registered, regressed: regressed, total: findings.length };
}

// ── Voll-Scan aller Apps ────────────────────────────────────────────

function fullScan() {
  var rules = craRules.loadRules();
  var apps = (rules && rules.apps) || [];
  var allFindings = [];

  console.log('[CRA/Scanner] Starte Voll-Scan (' + apps.length + ' Apps)...');

  apps.forEach(function(app) {
    if (!app.staging_dir) return;
    var dir = app.staging_dir;

    // Code-Patterns
    var codeFindings = scanRepo(dir, app.id);
    allFindings = allFindings.concat(codeFindings);

    // npm audit (nur wenn node_modules existiert)
    if (fs.existsSync(path.join(dir, 'node_modules'))) {
      var depFindings = npmAudit(dir, app.id);
      allFindings = allFindings.concat(depFindings);
    }
  });

  var result = registerFindings(allFindings);
  console.log('[CRA/Scanner] Voll-Scan abgeschlossen:', result.total, 'Patterns,', result.registered, 'neu,', result.regressed, 'Regressionen');
  return result;
}

// ── Offene Findings nach Severity sortiert ──────────────────────────

function getOpenFindings() {
  return craDb.all(
    "SELECT * FROM findings WHERE status = 'open' ORDER BY " +
    "CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END, " +
    "created_at ASC"
  ) || [];
}

module.exports = {
  fullScan: fullScan,
  scanRepo: scanRepo,
  npmAudit: npmAudit,
  registerFindings: registerFindings,
  getOpenFindings: getOpenFindings,
  CODE_PATTERNS: CODE_PATTERNS
};
