// admin/cra/cra-analyzer.js — Autonome Diff-Analyse + GitHub/Forgejo Webhook
var crypto = require('crypto');
var child = require('child_process');
var craDb = require('./cra-db');
var craRules = require('./cra-rules');
var githubStatus = require('./github-status');
var githubDiff = require('./github-diff');
var githubChecks = require('./github-checks');
var forgejoStatus = require('./forgejo-status');
var minioUploader = require('./minio-uploader');

var WEBHOOK_SECRET = process.env.CRA_WEBHOOK_SECRET || '';

// ── GitHub Webhook Signatur-Validierung ─────────────────────────────
function verifySignature(payload, signature) {
  if (!WEBHOOK_SECRET) return false;
  if (!signature || typeof signature !== 'string') return false;
  var expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  var a = Buffer.from(expected);
  var b = Buffer.from(signature);
  // timingSafeEqual crasht bei unterschiedlicher Laenge — explizit guarden
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Diff holen (lokal auf dem Server) ───────────────────────────────
function getDiff(repoPath, commitSha, parentSha) {
  try {
    var args = parentSha
      ? ['-C', repoPath, 'diff', parentSha, commitSha]
      : ['-C', repoPath, 'diff', commitSha + '~1', commitSha];
    var result = child.spawnSync('git', args, { encoding: 'utf8', timeout: 15000 });
    return result.stdout || '';
  } catch (e) {
    console.error('[CRA/Analyzer] Diff-Fehler:', e.message);
    return '';
  }
}

// Dateien die aus dem Diff herausgefiltert werden bevor Pattern-Matching läuft.
// Grund: Diese Dateien enthalten per Definition Detection-Strings (Regex-Patterns
// für SQL-Injection, XSS, Shell-Injection etc.), die andernfalls von den eigenen
// CRA-Regeln gematcht würden — Detector wird fälschlich als Vulnerability klassifiziert.
//
// (CRA-SELF-007 Self-Reference, ursprünglich für rules-Datei selbst.
//  Erweitert 28.04.2026 um Detector-Konvention "*risk-patterns*.js" + weitere
//  Sanitizer-/Validator-/WAF-Pattern-Files in App-Repos.)
var EXCLUDED_PATHS = ['data/cra-rules.json'];
var EXCLUDED_PATH_REGEXES = [
  /(^|\/)(risk[-_]patterns?|feedback-risk-patterns)\.(js|ts|mjs|cjs|json)$/,
  /(^|\/)(sanitizer|validator|waf)-patterns?\.(js|ts|mjs|cjs|json)$/,
  /(^|\/)security-patterns?\.(js|ts|mjs|cjs|json)$/,
  // Doku-Pfade: Specs/ADRs/Runbooks/Legal enthalten per Definition Code-Beispiele,
  // SQL-Snippets, Pseudocode mit Provider-Namen sowie DSGVO-Termini (CSRF, CSP,
  // Helmet) als Fließtext — Architektur- und Rechtsdiskussion, kein ausführbarer Code.
  // Risk-Patterns würden False-Positives produzieren.
  /(^|\/)docs\/(specs|adr|compliance|architecture|runbooks|legal)\/.*\.(md|markdown)$/,
  // Plattform-Infrastructure: TenantScopedDb + Repository-Implementierungen sind
  // per Definition Schicht-Ebene mit parametrisierten mysql2-Aufrufen. arch-12
  // (Raw-SQL nur in infrastructure/) würde sich selbst flaggen.
  /(^|\/)backend\/src\/platform\/db\/.*\.(js|ts|mjs|cjs)$/,
  /(^|\/)backend\/src\/(platform|modules)\/[^/]+\/infrastructure\/.*\.(js|ts|mjs|cjs)$/,
  /(^|\/)backend\/src\/(platform|modules)\/[^/]+\/repository\.(js|ts|mjs|cjs)$/,
  // Superadmin-Layer: cross-tenant administrative queries per Design (RFC-E7C97DFC,
  // RFC-DCCD8649 Override). Kein reguläres Domain-Modul — SA-Routes dürfen direkt
  // auf db/pool zugreifen (PLattform-Ebene, nicht App-Domain-Ebene). arch-12 FP.
  /(^|\/)backend\/src\/platform\/superadmin\/.*\.(js|ts|mjs|cjs)$/,
  // Test-Files: Mocks reproduzieren echte SQL-Strings, Stub-DBs, etc. —
  // per Definition non-production-code. arch-12 + vuln-01 würden auf
  // Test-Mocks dauerhaft false-positiv triggern.
  /(^|\/)tests?\/.*\.(test|spec)\.(js|ts|mjs|cjs)$/,
  /(^|\/)tests?\/(unit|integration|e2e|browser|fixtures|scripts)\/.*\.(js|ts|mjs|cjs|json)$/,
  /(^|\/)__tests?__\/.*\.(js|ts|mjs|cjs)$/,
  // TinaCMS auto-generated Schema-Files: GraphQL-Fragments + TS-Types werden
  // vom tinacms-CLI aus tina/config.ts generiert. Enthalten zwingend GraphQL-
  // Fragment-Strings die wie SQL aussehen (vuln-01 false-positive) und any-Types
  // (risk-10). TinaCloud erwartet diese Files auf main-Branch — gitignore raus,
  // CRA-Detector-Skip in (10.05.2026, RFC-32310630-Folge).
  /(^|\/)tina\/__generated__\/.*$/,
  /(^|\/)tina-lock\.json$/,
  // Astro/MDX Static-Site-Files: .astro Templates und .mdx Content-Files sind
  // reine Static-Site-Generator-Dateien ohne DB-Zugriff. Astro getStaticPaths()
  // verwendet zwingend `params: { slug: ... }` (Routing-Konvention) und MDX-
  // Frontmatter enthält YAML-Felder wie `path:`, `date:` die im diff-Kontext
  // fälschlicherweise als SQL-Parametrisierung erkannt werden (vuln-01 FP).
  // HTML-Templates analog (keine SQL-Ausführung, reine Ausgabe).
  /\.(astro|mdx|html)$/,
];

function isExcludedPath(p) {
  if (EXCLUDED_PATHS.indexOf(p) !== -1) return true;
  for (var i = 0; i < EXCLUDED_PATH_REGEXES.length; i++) {
    if (EXCLUDED_PATH_REGEXES[i].test(p)) return true;
  }
  return false;
}

// Filtert Hunks der EXCLUDED_PATHS aus einem Unified-Diff.
function stripExcludedPaths(diff) {
  if (!diff) return diff;
  var parts = diff.split(/(?=^diff --git )/m);
  var kept = parts.filter(function(part) {
    var m = part.match(/^diff --git a\/(\S+)/);
    if (!m) return true;
    return !isExcludedPath(m[1]);
  });
  return kept.join('');
}

// ── Diff analysieren ────────────────────────────────────────────────
function analyzeDiff(diff, rules) {
  var findings = [];
  var totalScore = 0;
  var additions = 0;
  var deletions = 0;
  // Self-Reference vermeiden: rules-Datei (und weitere konfigurierte
  // Pfade) aus dem Diff entfernen bevor die Regex-Patterns laufen.
  diff = stripExcludedPaths(diff);
  var lines = diff.split('\n');

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }

  // Risk-Patterns prüfen
  var riskPatterns = (rules.risk_patterns || []).filter(function(p) { return p.enabled; });
  for (var r = 0; r < riskPatterns.length; r++) {
    var rp = riskPatterns[r];
    try {
      var regex = new RegExp(rp.pattern, 'gim');
      var matches = diff.match(regex);
      if (matches && matches.length > 0) {
        findings.push({
          type: 'risk',
          id: rp.id,
          severity: rp.severity,
          message: rp.message,
          score: rp.score,
          count: matches.length
        });
        totalScore += rp.score * Math.min(matches.length, 3); // Cap bei 3x
      }
    } catch (e) { /* ungültiger Regex */ }
  }

  // Secret-Patterns prüfen (nur auf hinzugefügte Zeilen)
  var addedLines = lines.filter(function(l) { return l.startsWith('+') && !l.startsWith('+++'); }).join('\n');
  var secretPatterns = (rules.secret_patterns || []).filter(function(p) { return p.enabled; });
  for (var s = 0; s < secretPatterns.length; s++) {
    var sp = secretPatterns[s];
    try {
      var sRegex = new RegExp(sp.pattern, 'gi');
      if (sRegex.test(addedLines)) {
        findings.push({
          type: 'secret',
          id: sp.id,
          severity: 'CRITICAL',
          message: 'Secret gefunden: ' + sp.name,
          score: 15
        });
        totalScore += 15;
      }
    } catch (e) { /* ungültiger Regex */ }
  }

  // Vuln-Patterns prüfen (nur auf hinzugefügte Zeilen)
  var vulnPatterns = (rules.vuln_patterns || []).filter(function(p) { return p.enabled; });
  for (var v = 0; v < vulnPatterns.length; v++) {
    var vp = vulnPatterns[v];
    try {
      var vRegex = new RegExp(vp.pattern, 'gi');
      if (vRegex.test(addedLines)) {
        findings.push({
          type: 'vuln',
          id: vp.id,
          severity: vp.severity,
          message: 'Vulnerability: ' + vp.name,
          score: vp.severity === 'CRITICAL' ? 10 : (vp.severity === 'HIGH' ? 5 : 2)
        });
        totalScore += vp.severity === 'CRITICAL' ? 10 : (vp.severity === 'HIGH' ? 5 : 2);
      }
    } catch (e) { /* ungültiger Regex */ }
  }

  // Deploy-Rules prüfen (kontextabhängig)
  var deployRules = rules.deploy_rules || [];
  for (var dr = 0; dr < deployRules.length; dr++) {
    var rule = deployRules[dr];
    // SSO-Secret Hardcoding
    if (rule.id === 'DR-02' && /[+].*KS_SSO_SECRET\s*=\s*['"][^'"]+['"]/i.test(addedLines)) {
      findings.push({ type: 'deploy-rule', id: rule.id, severity: 'CRITICAL', message: rule.rule, score: 15 });
      totalScore += 15;
    }
    // IMAP INBOX
    if (rule.id === 'DR-03' && /[+].*(?:openBox|IMAP_FOLDER).*['"]INBOX['"]/i.test(addedLines)) {
      findings.push({ type: 'deploy-rule', id: rule.id, severity: 'CRITICAL', message: rule.rule, score: 15 });
      totalScore += 15;
    }
  }

  // Risk-Level bestimmen
  var riskLevel = 'LOW';
  if (totalScore >= 20) riskLevel = 'CRITICAL';
  else if (totalScore >= 10) riskLevel = 'HIGH';
  else if (totalScore >= 5) riskLevel = 'MEDIUM';

  return {
    findings: findings,
    riskScore: totalScore,
    riskLevel: riskLevel,
    additions: additions,
    deletions: deletions
  };
}

// ── Analyse ausführen und in DB speichern ───────────────────────────
function runAnalysis(opts) {
  var rules = craRules.loadRules();
  if (!rules) { console.error('[CRA/Analyzer] Regeln nicht ladbar'); return null; }

  // Kill Switch — wenn Pipeline deaktiviert, keine Analyse
  if (rules.pipeline && rules.pipeline.enabled === false) {
    console.log('[CRA/Analyzer] Pipeline DEAKTIVIERT (Kill Switch) — Analyse übersprungen für', opts.repoName || 'unbekannt');
    return { rfcId: null, overallStatus: 'SKIPPED', riskScore: 0, findings: 0, message: 'CRA deaktiviert (Admin Kill Switch)' };
  }

  var diff = opts.diff || getDiff(opts.repoPath, opts.commitSha, opts.parentSha);
  if (!diff || diff.length < 10) {
    console.log('[CRA/Analyzer] Kein relevanter Diff für', opts.repoName || 'unbekannt');
    return null;
  }

  // Diff-Deduplizierung: identischer Diff bereits analysiert + approved/overridden?
  var diffHash = crypto.createHash('sha256').update(diff).digest('hex');
  var existingRfc = craDb.get(
    "SELECT * FROM rfc_runs WHERE diff_hash = ? AND overall_status IN ('APPROVED','OVERRIDDEN') ORDER BY created_at DESC LIMIT 1",
    [diffHash]
  );
  if (existingRfc) {
    console.log('[CRA/Analyzer] Diff-Duplikat erkannt:', existingRfc.id, existingRfc.overall_status, '— Reuse fuer', opts.repoName || '');
    return {
      rfcId: existingRfc.id,
      overallStatus: existingRfc.overall_status,
      riskScore: existingRfc.risk_score,
      riskLevel: existingRfc.risk_level,
      findings: existingRfc.findings_json ? JSON.parse(existingRfc.findings_json).length : 0,
      additions: existingRfc.additions,
      deletions: existingRfc.deletions,
      reused: true
    };
  }

  // Override-Token-Lookup (2026-04-25, Phase 0.3): Diff-Hash hat sich aendern koennen
  // (z.B. Whitespace, kleine Edits nach Override). Wenn fuer (repo, branch) ein aktiver
  // Approval-Token existiert (expires_at > now, used_at IS NULL), dann gilt der Override
  // fuer den naechsten Commit auf demselben Branch. Token wird single-use markiert.
  if (opts.repoName && opts.branch) {
    var activeApproval = craDb.get(
      "SELECT a.*, r.risk_score AS orig_risk_score, r.risk_level AS orig_risk_level, r.findings_json AS orig_findings_json " +
      "FROM approvals a LEFT JOIN rfc_runs r ON r.id = a.rfc_id " +
      "WHERE a.repo_name = ? AND a.branch = ? AND a.action = 'override' " +
      "AND a.used_at IS NULL AND datetime(a.expires_at) > datetime('now','localtime') " +
      "ORDER BY a.created_at DESC LIMIT 1",
      [opts.repoName, opts.branch]
    );
    if (activeApproval) {
      var newRfcId = 'RFC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      // Token einlösen: used_at + neue rfcId markieren (single-use)
      craDb.run(
        "UPDATE approvals SET used_at = datetime('now','localtime'), used_for_rfc_id = ? WHERE id = ?",
        [newRfcId, activeApproval.id]
      );
      // Schlanken RFC-Eintrag anlegen (Audit-Trail), markiert als OVERRIDDEN via Token
      craDb.run(
        'INSERT OR REPLACE INTO rfc_runs (id, title, change_type, repo_path, app_name, diff_source, risk_score, risk_level, gate1_status, gate1_details, gate2_status, gate2_details, gate3_status, gate3_details, overall_status, approved_by, override_reason, additions, deletions, findings_json, report_text, diff_hash, commit_sha, repo_full_name, branch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [newRfcId, (opts.repoName + ': ' + (opts.commitMessage || 'Override-Token-Reuse')).substring(0, 200),
         opts.changeType || 'Normal Change', opts.repoPath || '', opts.repoName,
         opts.diffSource || 'pre-commit', activeApproval.orig_risk_score || 0, activeApproval.orig_risk_level || 'unknown',
         'PASSED', 'Via Override-Token (Quelle: ' + activeApproval.rfc_id + ')',
         'PASSED', 'Via Override-Token',
         'PASSED', 'Via Override-Token',
         'OVERRIDDEN', 'override-token', activeApproval.reason || '',
         0, 0, '[]',
         'Override-Token Reuse fuer ' + opts.repoName + '/' + opts.branch + '\nQuell-RFC: ' + activeApproval.rfc_id + '\nApproval-ID: ' + activeApproval.id,
         diffHash, opts.commitSha || null, opts.repoFullName || null, opts.branch]
      );
      craDb.saveCraDb();
      console.log('[CRA/Analyzer] Override-Token eingeloest:', activeApproval.rfc_id, '→', newRfcId, '— Repo:', opts.repoName, 'Branch:', opts.branch);
      return {
        rfcId: newRfcId,
        overallStatus: 'OVERRIDDEN',
        riskScore: activeApproval.orig_risk_score || 0,
        riskLevel: activeApproval.orig_risk_level || 'unknown',
        findings: 0,
        additions: 0,
        deletions: 0,
        viaOverrideToken: activeApproval.rfc_id
      };
    }
  }

  var result = analyzeDiff(diff, rules);

  // AST Engine (sync, fire-and-merge — fails gracefully if container down)
  try {
    var execFileSync = require('child_process').execFileSync;
    var fs = require('fs');
    var astTmp = '/tmp/cra-ast-' + Date.now() + '.json';
    fs.writeFileSync(astTmp, JSON.stringify({ diff: diff.substring(0, 50000) }));
    var astOut = execFileSync('curl', ['-s', '--max-time', '8', '-X', 'POST',
      'http://10.89.1.42:3000/charter-check',
      '-H', 'Content-Type: application/json', '-d', '@' + astTmp],
      { timeout: 10000, encoding: 'utf8' });
    try { fs.unlinkSync(astTmp); } catch(_) {}
    var astResp = JSON.parse(astOut);
    if (astResp && Array.isArray(astResp.results)) {
      astResp.results.forEach(function(r) {
        if ((r.status === 'fail' || r.status === 'violation') && Array.isArray(r.violations)) {
          r.violations.forEach(function(v) {
            var sev = (v.severity || 'MEDIUM').toUpperCase();
            var score = v.score || (sev === 'CRITICAL' ? 25 : sev === 'HIGH' ? 15 : sev === 'MEDIUM' ? 8 : 3);
            result.findings.push({
              severity: sev,
              message: '[AST/' + r.ruleId + '] ' + (v.message || 'violation'),
              score: score,
              type: 'ast',
              count: 1
            });
            result.riskScore += score;
          });
        }
      });
      if (result.riskScore > 0) {
        result.riskLevel = result.riskScore >= 20 ? 'HIGH' : result.riskScore >= 10 ? 'MEDIUM' : 'LOW';
      }
    }
  } catch(astErr) {
    // AST Engine down oder Timeout — kein Block, nur Log
    if (astErr.code !== 'ENOENT') {
      console.warn('[CRA/Analyzer] AST Engine nicht erreichbar:', astErr.message ? astErr.message.substring(0, 80) : astErr.code);
    }
  }

  var blockThreshold = rules.pipeline.block_threshold || 20;

  // Gate-Status (müssen VOR overallStatus berechnet werden, damit sie blockieren können)
  var gate1 = result.findings.some(function(f) { return f.severity === 'CRITICAL'; }) ? 'FAILED' : 'PASSED';
  var gate2 = result.riskScore < blockThreshold ? 'PASSED' : 'FAILED';
  var gate3 = result.findings.some(function(f) { return f.type === 'secret'; }) ? 'FAILED' : 'PASSED';

  // Defense-in-Depth: jedes Gate kann eigenständig blockieren (CRA-SELF-001)
  var overallStatus = (gate1 === 'FAILED' || gate2 === 'FAILED' || gate3 === 'FAILED') ? 'BLOCKED' : 'APPROVED';

  // Re-Push desselben, noch BLOCKED Diffs: bestehenden RFC per diff_hash
  // WIEDERVERWENDEN statt Duplikat anzulegen (Vorfall 2026-05-29, ADR-0036).
  // INSERT OR REPLACE aktualisiert dann dieselbe Zeile → RFC-ID bleibt über
  // Push-Versuche stabil. Der User overridet GENAU diese ID; der nächste Push
  // trifft die APPROVED/OVERRIDDEN-Dedup oben (Z.237) und passiert den Gate.
  // (APPROVED/OVERRIDDEN ist oben bereits abgefangen → hier nur BLOCKED möglich.)
  var priorBlocked = craDb.get(
    "SELECT id FROM rfc_runs WHERE diff_hash = ? AND overall_status = 'BLOCKED' ORDER BY created_at DESC LIMIT 1",
    [diffHash]
  );
  var rfcId = (priorBlocked && priorBlocked.id)
    ? priorBlocked.id
    : ('RFC-' + crypto.randomBytes(4).toString('hex').toUpperCase());
  if (priorBlocked && priorBlocked.id) {
    console.log('[CRA/Analyzer] BLOCKED-Diff erneut gepusht — RFC wiederverwendet:', rfcId, '(kein Duplikat)');
  }
  var title = opts.title || (opts.repoName + ': ' + (opts.commitMessage || opts.commitSha || 'Analyse').substring(0, 80));

  // Report-Text generieren
  var reportLines = [
    '═══ CRA Autonomous Analysis ═══',
    'RFC: ' + rfcId,
    'Repo: ' + (opts.repoName || '-'),
    'Commit: ' + (opts.commitSha || '-').substring(0, 8),
    'Branch: ' + (opts.branch || '-'),
    'Status: ' + overallStatus,
    'Risk Score: ' + result.riskScore + ' (Threshold: ' + blockThreshold + ')',
    'Risk Level: ' + result.riskLevel,
    'Changes: +' + result.additions + ' / -' + result.deletions,
    '',
    'Gate 1 (Risk Assessment): ' + gate1,
    'Gate 2 (Score Threshold): ' + gate2,
    'Gate 3 (Secret Scan): ' + gate3,
    ''
  ];

  if (result.findings.length > 0) {
    reportLines.push('── Findings (' + result.findings.length + ') ──');
    result.findings.forEach(function(f) {
      reportLines.push('[' + f.severity + '] ' + f.message + (f.count ? ' (' + f.count + 'x)' : '') + ' [Score: ' + f.score + ']');
    });
  } else {
    reportLines.push('Keine Findings.');
  }

  var reportText = reportLines.join('\n');

  // In DB speichern
  try {
    craDb.run(
      'INSERT OR REPLACE INTO rfc_runs (id, title, change_type, repo_path, app_name, diff_source, risk_score, risk_level, gate1_status, gate1_details, gate2_status, gate2_details, gate3_status, gate3_details, overall_status, approved_by, additions, deletions, findings_json, report_text, diff_hash, commit_sha, repo_full_name, branch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [rfcId, title, opts.changeType || 'Normal Change', opts.repoPath || '', opts.repoName || '',
       opts.diffSource || 'webhook', result.riskScore, result.riskLevel,
       gate1, gate1 === 'PASSED' ? 'Keine Critical Findings' : 'Critical Findings gefunden',
       gate2, 'Score ' + result.riskScore + ' vs Threshold ' + blockThreshold,
       gate3, gate3 === 'PASSED' ? 'Keine Secrets gefunden' : 'Secrets im Code!',
       overallStatus, 'CRA-Auto', result.additions, result.deletions,
       JSON.stringify(result.findings), reportText + '\n\n── Changed Files (Phase 2.4) ──\n' + formatFileChangesTable(extractFileChanges(diff)),
       diffHash, opts.commitSha || null, opts.repoFullName || null, opts.branch || null]
    );
    craDb.saveCraDb();
    console.log('[CRA/Analyzer]', rfcId, overallStatus, '— Score:', result.riskScore, '— Findings:', result.findings.length, '—', opts.repoName || '');

    // Auto-Findings: Neue Findings automatisch in Registry eintragen
    if (result.findings.length > 0) {
      autoRegisterFindings(result.findings, opts.repoName, rfcId);
    }

    // Auto-SUPERSEDED: Wenn APPROVED, prüfe ob ältere BLOCKED RFCs abgelöst werden
    if (overallStatus === 'APPROVED' && opts.repoName) {
      checkSuperseded(rfcId, opts.repoName, diff, opts.branch);
    }
  } catch (e) {
    console.error('[CRA/Analyzer] DB-Fehler:', e.message);
  }

  // MinIO: Report fire-and-forget
  process.nextTick(function() {
    minioUploader.uploadReport(rfcId, opts.repoName, {
      rfcId: rfcId, repo: opts.repoName, branch: opts.branch,
      overallStatus: overallStatus, riskScore: result.riskScore,
      riskLevel: result.riskLevel, findings: result.findings.length,
      additions: result.additions, deletions: result.deletions,
      commitSha: opts.commitSha, commitMessage: opts.commitMessage,
      ts: new Date().toISOString()
    });
  });

  return {
    rfcId: rfcId,
    overallStatus: overallStatus,
    riskScore: result.riskScore,
    riskLevel: result.riskLevel,
    findings: result.findings.length,
    additions: result.additions,
    deletions: result.deletions
  };
}

// ── Repo-Pfad aus App-Katalog ermitteln ─────────────────────────────
function findRepoPath(repoName) {
  var rules = craRules.loadRules();
  if (!rules || !rules.app_catalog) return null;
  var app = rules.app_catalog.find(function(a) { return a.repo === repoName; });
  if (!app || !app.user || app.user === '-') return null;
  // Prod-Pfad
  if (app.user === 'root') return process.env.MERIDIAN_BASE_PATH || '/opt/ks-management';
  return '/home/' + app.user + '/htdocs/' + app.domain;
}

// ── GitHub + Forgejo Webhook Handler ───────────────────────────────
function handleWebhook(req, res, opts) {
  var json = opts.json;
  var bodyFn = opts.body;

  return bodyFn(req).then(function(rawBody) {
    // Signatur PFLICHT — sonst kann jeder Webhook-Endpoint aufrufen (Retro CRITICAL #2)
    if (!WEBHOOK_SECRET) {
      console.error('[CRA/Webhook] CRA_WEBHOOK_SECRET nicht gesetzt — Webhook deaktiviert');
      return json(res, { error: 'Server misconfigured (webhook secret missing)' }, 500);
    }
    var sig = req.headers['x-hub-signature-256'];
    if (!sig) {
      console.warn('[CRA/Webhook] Signatur-Header fehlt (x-hub-signature-256)');
      return json(res, { error: 'Signature required' }, 401);
    }
    if (!verifySignature(rawBody, sig)) {
      console.warn('[CRA/Webhook] Ungueltige Signatur');
      return json(res, { error: 'Invalid signature' }, 401);
    }

    // Forgejo sendet x-gitea-event; GitHub sendet x-github-event
    var isForgejoSource = !!req.headers['x-gitea-event'];
    var event = req.headers['x-gitea-event'] || req.headers['x-github-event'];
    if (event === 'ping') {
      console.log('[CRA/Webhook] Ping empfangen');
      return json(res, { ok: true, event: 'ping' });
    }

    // ── check_run / check_suite / pull_request → DB-Cache (Schritt 3) ──
    if (event === 'check_run' || event === 'check_suite' || event === 'pull_request') {
      try {
        var p = JSON.parse(rawBody);
        var r;
        if (event === 'check_run') r = githubChecks.upsertCheckRun(p);
        else if (event === 'check_suite') r = githubChecks.recordCheckSuite(p);
        else r = githubChecks.recordPullRequest(p);
        console.log('[CRA/Webhook]', event, JSON.stringify(r));
        return json(res, { ok: true, event: event, result: r });
      } catch (e) {
        console.error('[CRA/Webhook]', event, 'error:', e.message);
        return json(res, { error: e.message, event: event }, 400);
      }
    }

    if (event !== 'push') {
      return json(res, { ok: true, event: event, skipped: true });
    }

    try {
      var payload = JSON.parse(rawBody);
      var repoName = payload.repository ? payload.repository.name : 'unknown';
      var branch = (payload.ref || '').replace('refs/heads/', '');
      var commits = payload.commits || [];

      if (commits.length === 0) {
        return json(res, { ok: true, skipped: true, reason: 'no commits' });
      }

      // Letzten Commit analysieren
      var lastCommit = commits[commits.length - 1];
      var repoPath = findRepoPath(repoName);
      var repoFullName = payload.repository ? payload.repository.full_name : null;

      var source = isForgejoSource ? 'forgejo' : 'github';
      console.log('[CRA/Webhook] Push (' + source + '):', repoName, branch, lastCommit.id.substring(0, 8), '—', lastCommit.message.substring(0, 60));

      // Wenn Repo-Pfad auf Server bekannt → git fetch + Analyse
      if (repoPath) {
        setImmediate(function() {
          try {
            // Race-Condition Mitigation v2: bei Forgejo direkt vom Container fetchen
            // (Forgejo-Webhook feuert ~1 Sek vor Push-Mirror-Sync zu GitHub)
            if (isForgejoSource) {
              var internalUrl = forgejoStatus.getInternalCloneUrl(repoFullName);
              if (internalUrl) {
                var remotes = child.spawnSync('git', ['-C', repoPath, 'remote'], { timeout: 5000, encoding: 'utf8' });
                var hasForgejoRemote = remotes.stdout && remotes.stdout.includes('forgejo');
                var remoteCmd = hasForgejoRemote ? 'set-url' : 'add';
                child.spawnSync('git', ['-C', repoPath, 'remote', remoteCmd, 'forgejo', internalUrl], { timeout: 5000 });
                child.spawnSync('git', ['-C', repoPath, 'fetch', 'forgejo', branch], { timeout: 15000 });
              } else {
                child.spawnSync('git', ['-C', repoPath, 'fetch', 'origin', branch], { timeout: 15000 });
              }
            } else {
              child.spawnSync('git', ['-C', repoPath, 'fetch', 'origin', branch], { timeout: 15000 });
            }

            var result = runAnalysis({
              repoPath: repoPath,
              repoName: repoName,
              repoFullName: repoFullName,
              commitSha: lastCommit.id,
              parentSha: payload.before,
              commitMessage: lastCommit.message,
              branch: branch,
              diffSource: isForgejoSource ? 'forgejo-webhook' : 'github-webhook'
            });

            if (result) {
              console.log('[CRA/Webhook] Analyse fertig:', result.rfcId, result.overallStatus);
            }

            // Status-Check posten (fire-and-forget)
            var statusMod = isForgejoSource ? forgejoStatus : githubStatus;
            statusMod.postFromAnalysis({
              repoFullName: repoFullName,
              sha: lastCommit.id,
              result: result
            }).catch(function(e) {
              console.warn('[CRA/Webhook] Status-Post fehlgeschlagen:', e && e.message);
            });

            // ADR-0029 Phase 2a: cra/2nd-pass-review initial pending/success posten
            statusMod.post2ndPassInitial({
              repoFullName: repoFullName,
              sha: lastCommit.id,
              result: result
            }).catch(function(e) {
              console.warn('[CRA/Webhook] 2nd-Pass-Initial-Post fehlgeschlagen:', e && e.message);
            });
          } catch (e) {
            console.error('[CRA/Webhook] Analyse-Fehler:', e.message);
            var errMod = isForgejoSource ? forgejoStatus : githubStatus;
            errMod.postStatus({
              repo: repoFullName,
              sha: lastCommit.id,
              state: 'error',
              description: 'CRA analyzer error (check logs)'
            }).catch(function() {});
          }
        });

        return json(res, { ok: true, repo: repoName, branch: branch, analyzing: true });
      }

      // Kein lokaler Pfad: Forgejo hat keinen GitHub-Compare-Fallback → nur loggen
      if (isForgejoSource || !repoFullName) {
        var hookName = isForgejoSource ? 'forgejo-webhook' : 'github-webhook';
        console.warn('[CRA/Webhook] Kein lokaler Pfad für', repoName, '(' + source + ') — nur Event gespeichert');
        craDb.run(
          'INSERT INTO hook_events (hook_name, event_type, command, repo_name, details) VALUES (?,?,?,?,?)',
          [hookName, 'push', branch, repoName, commits.length + ' commits, latest: ' + lastCommit.message.substring(0, 100)]
        );
        craDb.saveCraDb();
        return json(res, { ok: true, repo: repoName, branch: branch, logged: true });
      }

      console.log('[CRA/Webhook] Kein lokaler Pfad für', repoName, '— Fallback: GitHub Compare API');
      setImmediate(function() {
        githubDiff.getCompareDiff({
          repoFullName: repoFullName,
          base: payload.before,
          head: lastCommit.id
        }).then(function(r) {
          if (!r.diff || r.diff.length < 10) {
            console.warn('[CRA/Webhook] GitHub-Diff leer für', repoName, lastCommit.id.substring(0, 8));
            githubStatus.postStatus({
              repo: repoFullName, sha: lastCommit.id, state: 'success',
              description: 'CRA: empty diff (no analysis)'
            }).catch(function() {});
            return;
          }

          var result = runAnalysis({
            repoName: repoName,
            repoFullName: repoFullName,
            commitSha: lastCommit.id,
            parentSha: payload.before,
            commitMessage: lastCommit.message,
            branch: branch,
            diff: r.diff,
            diffSource: 'github-compare'
          });

          if (result) {
            console.log('[CRA/Webhook] Analyse (via GitHub):', result.rfcId, result.overallStatus, '—', r.filesChanged, 'files');
          }

          githubStatus.postFromAnalysis({
            repoFullName: repoFullName,
            sha: lastCommit.id,
            result: result
          }).catch(function() {});

          githubStatus.post2ndPassInitial({
            repoFullName: repoFullName,
            sha: lastCommit.id,
            result: result
          }).catch(function() {});
        }).catch(function(e) {
          console.error('[CRA/Webhook] GitHub-Compare-Fehler:', repoName, lastCommit.id.substring(0, 8), '—', e.message);
          githubStatus.postStatus({
            repo: repoFullName, sha: lastCommit.id, state: 'error',
            description: ('CRA: ' + e.message).substring(0, 140)
          }).catch(function() {});
        });
      });

      return json(res, { ok: true, repo: repoName, branch: branch, analyzing: 'via-github-compare' });

    } catch (e) {
      console.error('[CRA/Webhook] Parse-Fehler:', e.message);
      return json(res, { error: 'Invalid payload' }, 400);
    }
  });
}

// ── Auto-Findings: Analyzer-Findings in Registry eintragen ─────

function autoRegisterFindings(findings, repoName, rfcId) {
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];

  findings.forEach(function(f) {
    // Eindeutige ID aus Finding-Typ + Pattern-ID + Repo
    var findingId = 'AF-' + (f.id || 'unknown') + '-' + (repoName || 'local').substring(0, 20);

    // Pruefen ob bereits existiert (kein Duplikat)
    var existing = craDb.get('SELECT id, status FROM findings WHERE id = ?', [findingId]);
    if (existing) {
      // Bereits gefixt? Regression!
      if (existing.status === 'fixed') {
        craDb.run(
          "UPDATE findings SET status = 'open', regression_verified = 0, updated_at = ? WHERE id = ?",
          [now, findingId]
        );
        console.log('[CRA/AutoFinding] Regression:', findingId);
      }
      return; // Bereits bekannt
    }

    // Severity-Mapping: Finding-Type → Finding-Severity
    var severity = f.severity || 'MEDIUM';

    // Kategorie aus Finding-Type
    var category = f.type || 'risk';
    if (f.id && f.id.startsWith('vuln-')) category = 'vulnerability';
    if (f.id && f.id.startsWith('sec-')) category = 'secret';

    craDb.run(
      "INSERT INTO findings (id, source, severity, category, title, description, apps_json, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [findingId, 'cra-analyzer', severity, category,
       f.message || 'Finding ' + f.id,
       'Automatisch erkannt in ' + (repoName || 'unknown') + ' (RFC: ' + rfcId + '). Score: ' + (f.score || 0),
       repoName ? JSON.stringify([repoName]) : null,
       'open', now, now]
    );
    console.log('[CRA/AutoFinding] Neu:', findingId, severity, f.message);
  });

  craDb.saveCraDb();
}

// ── Auto-SUPERSEDED: BLOCKED RFCs die durch spätere APPROVED abgelöst wurden ──

function extractChangedFiles(text) {
  if (!text) return [];
  var files = {};
  // Format 1: diff --git a/path/file b/path/file
  var diffMatches = text.match(/diff --git a\/(\S+)/g) || [];
  diffMatches.forEach(function(m) { files[m.replace('diff --git a/', '')] = true; });
  // Format 2: ── Changed Files ── Abschnitt (aus report_text)
  var cfSection = text.split('── Changed Files ──')[1];
  if (cfSection) {
    cfSection.split('\n').forEach(function(line) {
      var f = line.trim();
      // Phase 2.4: line kann "path | +A/-D | type" sein — extrahiere nur path
      var pathPart = f.split('|')[0].trim();
      if (pathPart && pathPart.length > 0 && pathPart.indexOf(' ') < 0) files[pathPart] = true;
    });
  }
  return Object.keys(files);
}

// Phase 2.4 (CRA-Strategie 2026-04-25): pro Datei die Aenderungs-Statistik extrahieren.
// Liefert [{path, additions, deletions, change_type}] fuer reportText + Dashboard.
function extractFileChanges(diff) {
  if (!diff) return [];
  var out = [];
  var sections = diff.split(/(?=^diff --git )/m);
  sections.forEach(function(sec) {
    var headerMatch = sec.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!headerMatch) return;
    var path = headerMatch[2];
    var changeType = 'modified';
    if (sec.indexOf('new file mode') !== -1) changeType = 'created';
    else if (sec.indexOf('deleted file mode') !== -1) changeType = 'deleted';
    else if (sec.indexOf('rename from') !== -1) changeType = 'renamed';
    var add = 0, del = 0;
    var lines = sec.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (L.startsWith('+') && !L.startsWith('+++')) add++;
      else if (L.startsWith('-') && !L.startsWith('---')) del++;
    }
    out.push({ path: path, additions: add, deletions: del, change_type: changeType });
  });
  return out;
}

// Formatiert extractFileChanges-Output als Tabelle fuer reportText (Phase 2.4)
function formatFileChangesTable(fileChanges) {
  if (!fileChanges || !fileChanges.length) return '(keine Files)';
  var maxPath = fileChanges.reduce(function(m, fc) { return Math.max(m, fc.path.length); }, 4);
  var lines = fileChanges.map(function(fc) {
    var pathPad = fc.path + ' '.repeat(Math.max(0, maxPath - fc.path.length));
    return pathPad + '  | +' + fc.additions + ' / -' + fc.deletions + '  | ' + fc.change_type;
  });
  return lines.join('\n');
}

function checkSuperseded(newRfcId, repoName, newDiff, newBranch) {
  var newFiles = extractChangedFiles(newDiff);

  // Alle BLOCKED RFCs für dasselbe Repo die ÄLTER sind
  var blocked = craDb.all(
    "SELECT id, branch, report_text, findings_json, created_at FROM rfc_runs WHERE app_name = ? AND overall_status = 'BLOCKED' AND id != ? ORDER BY created_at ASC",
    [repoName, newRfcId]
  );

  if (!blocked.length) return;

  // Alle APPROVED RFCs für dieses Repo sammeln (gesamte Datei-Abdeckung)
  var allApproved = craDb.all(
    "SELECT report_text FROM rfc_runs WHERE app_name = ? AND overall_status IN ('APPROVED','OVERRIDDEN')",
    [repoName]
  );
  var coveredFiles = {};
  allApproved.forEach(function(a) {
    extractChangedFiles(a.report_text || '').forEach(function(f) { coveredFiles[f] = true; });
  });
  // Auch Dateien aus dem aktuellen neuen Diff
  newFiles.forEach(function(f) { coveredFiles[f] = true; });

  var superseded = 0;
  blocked.forEach(function(b) {
    var bFiles = extractChangedFiles(b.report_text || '');
    if (!bFiles.length) {
      // Branch-aware Fallback: kein Diff extrahierbar (z.B. forgejo-pr) —
      // Supersede wenn der neue APPROVED RFC denselben Branch hat ODER
      // ein jüngeres APPROVED für diesen Branch bereits existiert.
      var sameBranch = newBranch && b.branch && newBranch === b.branch;
      var newerOnBranch = !sameBranch && b.branch ? craDb.get(
        "SELECT id FROM rfc_runs WHERE app_name = ? AND branch = ? AND overall_status IN ('APPROVED','OVERRIDDEN') AND created_at > ?",
        [repoName, b.branch, b.created_at]
      ) : null;
      if (sameBranch || newerOnBranch) {
        var reason = sameBranch
          ? 'Branch-Fallback: neues APPROVED auf gleichem Branch ' + b.branch + ' (' + newRfcId + ')'
          : 'Branch-Fallback: jüngeres APPROVED auf Branch ' + b.branch + ' (' + newerOnBranch.id + ')';
        craDb.run(
          "UPDATE rfc_runs SET overall_status = 'SUPERSEDED', override_reason = ? WHERE id = ?",
          [reason, b.id]
        );
        craDb.run(
          'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
          ['cra-analyzer', 'auto-superseded-branch', repoName, b.id, reason]
        );
        superseded++;
      }
      return;
    }
    // Sind ALLE Dateien des BLOCKED RFC durch APPROVED Commits abgedeckt?
    var allCovered = bFiles.every(function(f) { return coveredFiles[f]; });
    if (allCovered) {
      craDb.run(
        "UPDATE rfc_runs SET overall_status = 'SUPERSEDED', override_reason = ? WHERE id = ?",
        ['Automatisch: Alle Dateien durch spätere APPROVED RFCs abgedeckt (zuletzt: ' + newRfcId + ')', b.id]
      );
      craDb.run(
        'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
        ['cra-analyzer', 'auto-superseded', repoName, b.id, 'Abgelöst durch ' + newRfcId + ' + weitere']
      );
      superseded++;
    }
  });

  if (superseded > 0) {
    craDb.saveCraDb();
    console.log('[CRA/Analyzer] Auto-SUPERSEDED:', superseded, 'alte BLOCKED RFCs für', repoName);
  }
}

// ── Cleanup-Routine: Bereinigt obsolete RFCs, Findings, Test-Residuals ──

function runCleanup() {
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  var cleaned = { superseded: 0, findings_resolved: 0, test_residuals: 0 };

  // 1. BLOCKED RFCs → SUPERSEDED wenn spätere APPROVED existieren
  var repos = craDb.all("SELECT DISTINCT app_name FROM rfc_runs WHERE app_name IS NOT NULL AND app_name != ''");
  repos.forEach(function(r) {
    var repoName = r.app_name;
    var approved = craDb.all(
      "SELECT report_text FROM rfc_runs WHERE app_name = ? AND overall_status = 'APPROVED'",
      [repoName]
    );
    var coveredFiles = {};
    approved.forEach(function(a) {
      extractChangedFiles(a.report_text || '').forEach(function(f) { coveredFiles[f] = true; });
    });

    var blocked = craDb.all(
      "SELECT id, branch, report_text, created_at FROM rfc_runs WHERE app_name = ? AND overall_status = 'BLOCKED'",
      [repoName]
    );
    blocked.forEach(function(b) {
      var bFiles = extractChangedFiles(b.report_text || '');
      if (!bFiles.length) {
        // Branch-aware Fallback: kein Diff extrahierbar (z.B. forgejo-pr) —
        // Supersede wenn jüngeres APPROVED auf gleichem Branch existiert.
        if (b.branch) {
          var newerOnBranch = craDb.get(
            "SELECT id FROM rfc_runs WHERE app_name = ? AND branch = ? AND overall_status IN ('APPROVED','OVERRIDDEN') AND created_at > ?",
            [repoName, b.branch, b.created_at]
          );
          if (newerOnBranch) {
            var r1 = craDb.run(
              "UPDATE rfc_runs SET overall_status = 'SUPERSEDED', override_reason = ? WHERE id = ?",
              ['Cleanup/Branch-Fallback: jüngeres APPROVED auf Branch ' + b.branch + ' (' + newerOnBranch.id + ')', b.id]
            );
            if (r1.changes > 0) cleaned.superseded++;
            return;
          }
        }
        // Kein Diff + kein jüngeres APPROVED: nach 24h als SUPERSEDED
        var r2 = craDb.run(
          "UPDATE rfc_runs SET overall_status = 'SUPERSEDED', override_reason = 'Cleanup: Kein Diff, ältere APPROVED RFCs existieren (>24h)' WHERE id = ? AND created_at < datetime('now', '-24 hours')",
          [b.id]
        );
        if (r2.changes > 0) cleaned.superseded++;
        return;
      }
      var allCovered = bFiles.every(function(f) { return coveredFiles[f]; });
      if (allCovered) {
        var r3 = craDb.run(
          "UPDATE rfc_runs SET overall_status = 'SUPERSEDED', override_reason = 'Cleanup: Alle Dateien durch APPROVED RFCs abgedeckt' WHERE id = ?",
          [b.id]
        );
        if (r3.changes > 0) cleaned.superseded++;
      }
    });
  });

  // 2. Test-Residuals in Findings (RFC-SUBMIT für test/test-app)
  var testFindings = craDb.all(
    "SELECT id FROM findings WHERE id LIKE 'RFC-SUBMIT-%' AND (apps_json LIKE '%test-app%' OR apps_json LIKE '%\"test\"%') AND status = 'open'"
  );
  testFindings.forEach(function(f) {
    craDb.run("UPDATE findings SET status = 'resolved', updated_at = ? WHERE id = ?", [now, f.id]);
    cleaned.test_residuals++;
  });

  // 3. AF-* Findings mit Codebase-Verifikation (wenn Source-API verfügbar)
  //    Prüft ob das gemeldete Pattern tatsächlich noch im Code existiert
  var afFindings = craDb.all(
    "SELECT f.id, f.title, f.apps_json, f.category FROM findings f WHERE f.id LIKE 'AF-%' AND f.status = 'open'"
  );
  var rules = craRules.loadRules();
  var fs = require('fs');
  var path = require('path');

  afFindings.forEach(function(f) {
    var apps = [];
    try { apps = JSON.parse(f.apps_json || '[]'); } catch(e) {}
    var appId = (Array.isArray(apps) && apps[0]) || '';
    var app = (rules.apps || []).find(function(a) { return a.id === appId; });
    if (!app || !app.staging_dir) return;

    // Prüfe ob der Server-Code die gemeldete Schwachstelle noch enthält
    var serverJs = path.join(app.staging_dir || app.prod_dir, 'src', 'server.js');
    if (!fs.existsSync(serverJs)) serverJs = path.join(app.staging_dir || app.prod_dir, 'server.js');
    if (!fs.existsSync(serverJs)) return;

    try {
      var code = fs.readFileSync(serverJs, 'utf8');
      var stillPresent = false;

      // Einfache Heuristik: Prüfe ob typische Patterns noch im Code sind
      if (f.id.includes('vuln-01') && code.match(/\$\{.*\}.*SELECT|SELECT.*\+.*req\./)) stillPresent = true; // SQL Injection
      if (f.id.includes('risk-13') && code.includes('innerHTML')) stillPresent = true; // XSS innerHTML
      if (f.id.includes('vuln-04') && code.includes('innerHTML')) stillPresent = true; // XSS
      if (f.id.includes('risk-04') && code.match(/rm\s+-rf|DROP\s+TABLE|unlink.*req\./i)) stillPresent = true; // Destructive

      if (!stillPresent) {
        craDb.run("UPDATE findings SET status = 'resolved', updated_at = ?, lesson = 'Cleanup: Pattern nicht mehr im Code gefunden' WHERE id = ?", [now, f.id]);
        cleaned.findings_resolved++;
        console.log('[CRA/Cleanup] AF-Finding resolved (nicht mehr im Code):', f.id);
      }
    } catch (e) { /* Datei nicht lesbar — überspringen */ }
  });

  craDb.saveCraDb();

  // Event loggen
  craDb.run(
    'INSERT INTO hook_events (hook_name, event_type, details) VALUES (?,?,?)',
    ['cra-analyzer', 'cleanup', 'SUPERSEDED: ' + cleaned.superseded + ', Findings resolved: ' + cleaned.findings_resolved + ', Test-Residuals: ' + cleaned.test_residuals]
  );
  craDb.saveCraDb();

  console.log('[CRA/Cleanup]', JSON.stringify(cleaned));
  return cleaned;
}

module.exports = { handleWebhook, runAnalysis, analyzeDiff, getDiff, findRepoPath, runCleanup, checkSuperseded };
