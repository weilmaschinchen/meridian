// SPDX-License-Identifier: Apache-2.0
// admin/cra/cra-db.js — better-sqlite3 Datenbank fuer CRA (CommonJS)
// Migration von sql.js: WAL-Modus, sofortige Disk-Writes, Crash-safe
var Database = require('better-sqlite3');
var fs = require('fs');
var path = require('path');

// DB_PATH/MERIDIAN_DB_PATH erlauben Meridian-Deployments (Container: /data/meridian.db)
// auf dieselbe Datei zu zeigen, die meridian/migrate.js nutzt. Ohne ENV bleibt der
// Standard-Pfad data/cra.db erhalten (backward-kompatibel, kein Verhalten geaendert).
var DB_PATH = process.env.DB_PATH || process.env.MERIDIAN_DB_PATH || path.join(__dirname, '..', '..', 'data', 'cra.db');
var db = null;

async function initCraDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  console.log('[CRA/DB] Geladen (better-sqlite3 + WAL):', DB_PATH);

  // ── Schema ──────────────────────────────────────────────────────

  // RFC Pipeline Runs (Audit-Trail)
  db.exec(`CREATE TABLE IF NOT EXISTS rfc_runs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    change_type TEXT DEFAULT 'Normal Change',
    repo_path TEXT,
    app_name TEXT,
    diff_source TEXT,
    risk_score INTEGER DEFAULT 0,
    risk_level TEXT,
    gate1_status TEXT,
    gate1_details TEXT,
    gate2_status TEXT,
    gate2_details TEXT,
    gate3_status TEXT,
    gate3_details TEXT,
    overall_status TEXT,
    approved_by TEXT,
    override_reason TEXT,
    additions INTEGER DEFAULT 0,
    deletions INTEGER DEFAULT 0,
    findings_json TEXT,
    report_text TEXT,
    diff_hash TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Migration: diff_hash Spalte hinzufuegen falls Tabelle schon existiert
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN diff_hash TEXT"); } catch (e) { /* Spalte existiert bereits */ }

  // Migration: commit_sha + repo_full_name fuer GitHub Status Checks (2026-04-21)
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN commit_sha TEXT"); } catch (e) { /* Spalte existiert bereits */ }
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN repo_full_name TEXT"); } catch (e) { /* Spalte existiert bereits */ }

  // Migration: branch fuer Override-Token-Mechanismus (2026-04-25, Phase 0.3)
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN branch TEXT"); } catch (e) { /* Spalte existiert bereits */ }

  // Migration: LLM-Review-Pass (2026-04-25, Phase 2.1)
  // Zweite Bewertung pro RFC durch Qwen (klein) oder Haiku (gross/kritisch).
  // Verhindert "Stempel-Approver"-Bug (RFCs mit Score <20 wurden blind APPROVED).
  // llm_review_status: 'agree' (LLM stimmt regel-basierter Bewertung zu),
  //                    'disagree' (LLM sieht hoeheres Risiko — soll User informieren),
  //                    'no_run' (skipped — kein LLM verfuegbar).
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN llm_review_status TEXT"); } catch (e) { /* Spalte existiert bereits */ }
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN llm_review_severity TEXT"); } catch (e) { /* Spalte existiert bereits */ }
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN llm_review_concerns TEXT"); } catch (e) { /* Spalte existiert bereits */ }
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN llm_review_by TEXT"); } catch (e) { /* Spalte existiert bereits */ }
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN llm_review_at TEXT"); } catch (e) { /* Spalte existiert bereits */ }
  // LCR-Opt-B (2026-04-28): Confidence persistieren fuer 2nd-Pass-Skip-Heuristik.
  // 1st-pass mit confidence >= 0.85 spart 2nd-pass-Call (~70% Skip-Rate erwartet,
  // bei aktuell 99.3% agree-with-1st nahezu kein Quality-Verlust).
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN llm_review_confidence REAL"); } catch (e) { /* Spalte existiert bereits */ }

  // Migration: 2nd-Pass-Review fuer Phase 4 Option D (2026-04-25)
  // 14b verifiziert nochmals: alle disagrees + alle BLOCKED + alle HIGH/CRITICAL.
  // 2nd_status: 'agree-with-1st', 'disagree-with-1st', 'no_run'
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN llm_review_2nd_status TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN llm_review_2nd_severity TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN llm_review_2nd_concerns TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN llm_review_2nd_by TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN llm_review_2nd_at TEXT"); } catch (e) {}

  // ADR-0029 Phase 1 (2026-05-05): 2nd-Pass-Confidence persistieren + Status-Re-Eval-Audit-Log.
  // status_change_log = TEXT (JSON-Array, append-only) — SQLite kennt kein JSONB.
  // Eintrags-Shape: { ts, from, to, reason, by_model, confidence, error? }
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN llm_review_2nd_confidence REAL"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN status_change_log TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN status_re_eval_reason TEXT"); } catch (e) {}

  // E2 (2026-06-03): Gate 4 — Policy-Engine (built-in oder OPA/Enterprise).
  // gate4_status: 'PASSED'|'FAILED'|'SKIPPED' (SKIPPED wenn Policy-Engine nicht konfiguriert)
  // gate4_details: menschenlesbare Begründung (violations[] oder 'all rules passed')
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN gate4_status TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN gate4_details TEXT"); } catch (e) {}

  // E3 (2026-06-03): ITIL Change-Typ + SBOM-Gate + NIS-2-Incident-Flow
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN itil_change_type TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN itil_pre_approved INTEGER DEFAULT 0"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN rollback_plan TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN pir_required INTEGER DEFAULT 0"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN sbom_path TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN sbom_hash TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN nis2_incident_id TEXT"); } catch (e) {}

  // NIS-2 Incident-Tabelle (Art. 23 Eskalationsflow)
  db.exec(`CREATE TABLE IF NOT EXISTS nis2_incidents (
    id              TEXT PRIMARY KEY,
    rfc_id          TEXT NOT NULL,
    severity        TEXT,
    triggered_at    TEXT,
    bsi_24h_due     TEXT,
    bsi_72h_due     TEXT,
    bsi_1m_due      TEXT,
    status          TEXT DEFAULT 'open',
    template_json   TEXT,
    notes           TEXT,
    created_at      TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // E5 (2026-06-03): Decision-Log WORM + Reporting
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN worm_decision_key TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN worm_decision_hash TEXT"); } catch (e) {}

  // E6 (2026-06-03): CMDB-Graph — Blast-Radius + KRITIS-Auto-Erkennung
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN cmdb_blast_radius TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN cmdb_kritis_flag INTEGER DEFAULT 0"); } catch (e) {}
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN cmdb_source TEXT"); } catch (e) {}
  db.exec(`CREATE TABLE IF NOT EXISTS cmdb_cache (
    repo             TEXT PRIMARY KEY,
    blast_radius     TEXT DEFAULT 'LOW',
    kritis_flag      INTEGER DEFAULT 0,
    cis_json         TEXT,
    tenants_affected INTEGER DEFAULT 1,
    cached_at        TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS cmdb_mappings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    repo          TEXT NOT NULL,
    ci_id         TEXT,
    ci_name       TEXT,
    kritis        INTEGER DEFAULT 0,
    tenants       INTEGER DEFAULT 1,
    customer_facing INTEGER DEFAULT 0,
    source        TEXT DEFAULT 'manual',
    updated_at    TEXT DEFAULT (datetime('now','localtime'))
  )`);


  // T3 (2026-06-03): Delegation of Authority + Risk Intelligence
  db.exec(`CREATE TABLE IF NOT EXISTS identity_delegations (
    id            TEXT PRIMARY KEY,
    delegator_id  TEXT NOT NULL,
    delegate_id   TEXT NOT NULL,
    role          TEXT NOT NULL,
    valid_from    TEXT NOT NULL,
    valid_until   TEXT NOT NULL,
    scope_json    TEXT,
    reason        TEXT,
    revoked       INTEGER DEFAULT 0,
    revoked_by    TEXT,
    revoked_at    TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS risk_learning (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rfc_id     TEXT NOT NULL,
    action     TEXT NOT NULL,
    user_id    TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // T2 (2026-06-03): ITSM-Adapter Referenz-Tabelle
  db.exec(`CREATE TABLE IF NOT EXISTS itsm_refs (
    rfc_id      TEXT PRIMARY KEY,
    adapter     TEXT NOT NULL,
    external_id TEXT NOT NULL,
    synced_at   TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // T2 (2026-06-03): CAB-Management, PIR-Automation, SLA-Alerting
  db.exec(`CREATE TABLE IF NOT EXISTS cab_meetings (
    id            TEXT PRIMARY KEY,
    scheduled_at  TEXT NOT NULL,
    chair_user_id TEXT,
    description   TEXT,
    status        TEXT DEFAULT 'scheduled',
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    closed_at     TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS cab_queue (
    meeting_id    TEXT NOT NULL,
    rfc_id        TEXT NOT NULL,
    decision      TEXT,
    decision_notes TEXT,
    decided_by    TEXT,
    decided_at    TEXT,
    added_at      TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (meeting_id, rfc_id)
  )`);
  try { db.exec("ALTER TABLE nis2_incidents ADD COLUMN sla_breached INTEGER DEFAULT 0"); } catch (e) {}
  try { db.exec("ALTER TABLE nis2_incidents ADD COLUMN triggered_at TEXT"); } catch (e) {}

  // E11 (2026-06-03): OIDC/SSO Identity — Session-Management
  db.exec(`CREATE TABLE IF NOT EXISTS identity_sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    email        TEXT,
    roles_json   TEXT,
    mfa_verified INTEGER DEFAULT 0,
    expires_at   TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // E10 (2026-06-03): Scheduled Changes
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_changes (
    id            TEXT PRIMARY KEY,
    repo          TEXT NOT NULL,
    branch        TEXT DEFAULT 'main',
    description   TEXT,
    diff_snapshot TEXT,
    execute_at    TEXT NOT NULL,
    change_type   TEXT DEFAULT 'standard',
    window_name   TEXT,
    status        TEXT DEFAULT 'pending',
    rfc_id        TEXT,
    created_by    TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    executed_at   TEXT,
    cancelled_at  TEXT,
    cancel_reason TEXT,
    error_message TEXT
  )`);

  // E9 (2026-06-03): Approval-Workflow
  try { db.exec("ALTER TABLE rfc_runs ADD COLUMN submitter_user_id TEXT"); } catch (e) {}
  db.exec(`CREATE TABLE IF NOT EXISTS approval_records (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rfc_id     TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    action     TEXT NOT NULL,
    comment    TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_approval_rfc ON approval_records(rfc_id)"); } catch (e) {}

  // E8 (2026-06-03): Multi-Tenant Policy-Isolation
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_policy_config (
    tenant_id  TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT,
    updated_at TEXT,
    PRIMARY KEY (tenant_id, key)
  )`);

  // E4 (2026-06-03): Policy-Authoring — Konfigurierbare Policy-Parameter
  db.exec(`CREATE TABLE IF NOT EXISTS policy_config (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT
  )`);

  // ITIL PIR-Tabelle (Post-Implementation Review)
  db.exec(`CREATE TABLE IF NOT EXISTS itil_pir (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    rfc_id          TEXT NOT NULL,
    implemented_at  TEXT,
    status          TEXT DEFAULT 'pending',
    notes           TEXT,
    closed_at       TEXT,
    created_at      TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Hook-Events (deploy-guard + cra-tracker)
  db.exec(`CREATE TABLE IF NOT EXISTS hook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hook_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    command TEXT,
    repo_name TEXT,
    rfc_id TEXT,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Test-Laeufe
  db.exec(`CREATE TABLE IF NOT EXISTS test_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suite_name TEXT NOT NULL,
    target TEXT,
    total_tests INTEGER DEFAULT 0,
    passed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    duration_ms INTEGER,
    output TEXT,
    report_json TEXT,
    triggered_by TEXT,
    rfc_id TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Monitoring-Laeufe
  db.exec(`CREATE TABLE IF NOT EXISTS monitor_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    script_name TEXT NOT NULL,
    status TEXT,
    summary TEXT,
    report_json TEXT,
    triggered_by TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Findings Registry
  db.exec(`CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    source TEXT,
    severity TEXT,
    category TEXT,
    title TEXT NOT NULL,
    description TEXT,
    fix TEXT,
    lesson TEXT,
    apps_json TEXT,
    check_type TEXT,
    check_description TEXT,
    check_command TEXT,
    status TEXT DEFAULT 'open',
    regression_verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Migration: Persona-Tester-Felder fuer Beta-Cycle-Triage (2026-04-29)
  // cycle: 'beta-cycle-N' Gruppierung fuer Wochen-Triage
  // tenant: Multi-Tenant-Bug-Tracking (welcher Test-Tenant betroffen)
  // screenshot_url: Vision-Asserts hinterlassen Screenshots, hier referenziert
  // llm_suggested_severity: Bot-Vorschlag vor Regel-Override (fuer spaeteres Tuning)
  try { db.exec("ALTER TABLE findings ADD COLUMN cycle TEXT"); } catch (e) { /* Spalte existiert bereits */ }
  try { db.exec("ALTER TABLE findings ADD COLUMN tenant TEXT"); } catch (e) { /* Spalte existiert bereits */ }
  try { db.exec("ALTER TABLE findings ADD COLUMN screenshot_url TEXT"); } catch (e) { /* Spalte existiert bereits */ }
  try { db.exec("ALTER TABLE findings ADD COLUMN llm_suggested_severity TEXT"); } catch (e) { /* Spalte existiert bereits */ }

  // Cycles — Beta-Test-Cycles fuer Persona-Tester-Triage (2026-04-29)
  // Wochen-Lifecycle: Mo 06:00 Triage-Cron schliesst Cycle-N und oeffnet N+1.
  // status: 'open' (Findings werden gesammelt) | 'triaging' (Mo 06:00) | 'closed'
  db.exec(`CREATE TABLE IF NOT EXISTS cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    started_at TEXT DEFAULT (datetime('now','localtime')),
    closed_at TEXT,
    triage_summary_json TEXT,
    status TEXT DEFAULT 'open',
    findings_count INTEGER DEFAULT 0,
    critical_count INTEGER DEFAULT 0
  )`);

  // Prod-Gate Approvals
  db.exec(`CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfc_id TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    risk_score INTEGER DEFAULT 0,
    findings_count INTEGER DEFAULT 0,
    approved_by TEXT DEFAULT 'admin',
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Migration: Override-Token-Mechanismus fuer Pre-Commit Diff-Hash-Bug (2026-04-25, Phase 0.3)
  // branch + used_at + used_for_rfc_id ergaenzen, damit ein Override fuer (repo, branch) gilt
  // statt nur fuer den exakten Diff-Hash. Loest das Problem dass Re-Commits mit minimal
  // veraenderten Diffs den Override umgehen.
  try { db.exec("ALTER TABLE approvals ADD COLUMN branch TEXT"); } catch (e) { /* Spalte existiert bereits */ }
  try { db.exec("ALTER TABLE approvals ADD COLUMN used_at TEXT"); } catch (e) { /* Spalte existiert bereits */ }
  try { db.exec("ALTER TABLE approvals ADD COLUMN used_for_rfc_id TEXT"); } catch (e) { /* Spalte existiert bereits */ }

  db.exec(`CREATE TABLE IF NOT EXISTS claude_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT,
    picked_at TEXT,
    completed_at TEXT
  )`);

  // Prompt-Templates — App-spezifische Overrides fuer Worker-Prompts
  db.exec(`CREATE TABLE IF NOT EXISTS prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name TEXT NOT NULL,
    template TEXT NOT NULL,
    description TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Lern-Engine — Fix-Patterns + Instruction-Hints
  db.exec(`CREATE TABLE IF NOT EXISTS fix_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    fix_pattern TEXT,
    review_iterations INTEGER DEFAULT 1,
    duration_minutes INTEGER,
    finding_id TEXT,
    created_at TEXT
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS instruction_hints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT,
    stop_reason TEXT,
    hint TEXT NOT NULL,
    source_session TEXT,
    created_at TEXT
  )`);

  // Session-Logs
  db.exec(`CREATE TABLE IF NOT EXISTS session_logs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    finding_id TEXT,
    steps_json TEXT,
    finding_status TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_minutes INTEGER
  )`);

  // Test-Jobs — orchestrierte Test-Laeufe
  db.exec(`CREATE TABLE IF NOT EXISTS test_jobs (
    id TEXT PRIMARY KEY,
    finding_id TEXT,
    session_id TEXT,
    target TEXT DEFAULT 'staging',
    test_types TEXT DEFAULT '["unit"]',
    status TEXT DEFAULT 'pending',
    results_json TEXT,
    started_at TEXT,
    completed_at TEXT,
    triggered_by TEXT DEFAULT 'dispatcher'
  )`);

  // Eskalationen
  db.exec(`CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    finding_id TEXT,
    session_id TEXT,
    trigger_type TEXT NOT NULL,
    severity TEXT,
    channel TEXT,
    sla_minutes INTEGER,
    payload_json TEXT,
    status TEXT DEFAULT 'open',
    acknowledged_at TEXT,
    created_at TEXT
  )`);

  // Dispatch Sessions — autonome Claude Code Sessions
  db.exec(`CREATE TABLE IF NOT EXISTS dispatch_sessions (
    id TEXT PRIMARY KEY,
    finding_id TEXT,
    fsc_window_id TEXT,
    status TEXT DEFAULT 'pending',
    started_at TEXT,
    last_heartbeat TEXT,
    completed_at TEXT,
    result TEXT,
    trigger_mode TEXT DEFAULT 'api',
    error_message TEXT
  )`);

  // Review-Engine — Code-Review Requests + Audit
  db.exec(`CREATE TABLE IF NOT EXISTS review_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id TEXT,
    decision TEXT NOT NULL,
    static_failures TEXT,
    ai_decision TEXT,
    ai_comments TEXT,
    law_violations TEXT,
    diff_files TEXT,
    diff_additions INTEGER DEFAULT 0,
    diff_deletions INTEGER DEFAULT 0,
    iteration INTEGER DEFAULT 1,
    review_duration_ms INTEGER,
    created_at TEXT
  )`);

  // FSC — Forward Schedule of Change (Change-Fenster)
  db.exec(`CREATE TABLE IF NOT EXISTS fsc_windows (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'standard',
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    allowed_targets TEXT DEFAULT '["staging"]',
    allowed_severities TEXT DEFAULT '["critical","high","medium"]',
    max_findings INTEGER DEFAULT 5,
    rollback_window_min INTEGER DEFAULT 30,
    created_by TEXT DEFAULT 'admin',
    status TEXT DEFAULT 'scheduled',
    notes TEXT,
    created_at TEXT,
    updated_at TEXT
  )`);

  // Code Repository — wiederverwendbare Patterns + Snippets
  db.exec(`CREATE TABLE IF NOT EXISTS code_repository (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    pattern_name TEXT NOT NULL,
    description TEXT,
    code_snippet TEXT,
    language TEXT DEFAULT 'javascript',
    file_paths TEXT,
    tags_json TEXT DEFAULT '[]',
    meta_json TEXT DEFAULT '{}',
    created_by TEXT DEFAULT 'claude',
    usage_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // GitHub Checks Cache — check_run / check_suite Events pro SHA
  db.exec(`CREATE TABLE IF NOT EXISTS gh_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_full_name TEXT NOT NULL,
    sha TEXT NOT NULL,
    check_name TEXT NOT NULL,
    check_run_id INTEGER,
    status TEXT NOT NULL,
    conclusion TEXT,
    details_url TEXT,
    source TEXT NOT NULL,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(repo_full_name, sha, check_name)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gh_checks_sha ON gh_checks(repo_full_name, sha)`);

  // GitHub Pull Requests — SHA ↔ PR-Nummer Mapping
  db.exec(`CREATE TABLE IF NOT EXISTS gh_pulls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_full_name TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    base_sha TEXT,
    state TEXT NOT NULL,
    title TEXT,
    html_url TEXT,
    action TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(repo_full_name, pr_number, head_sha)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gh_pulls_sha ON gh_pulls(repo_full_name, head_sha)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gh_pulls_pr ON gh_pulls(repo_full_name, pr_number)`);

  // FP-Patterns (Phase 1.4, 2026-04-25)
  db.exec(`CREATE TABLE IF NOT EXISTS cra_fp_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    embedding_blob BLOB NOT NULL,
    embedding_dim INTEGER NOT NULL DEFAULT 768,
    source_finding_id INTEGER,
    created_by TEXT,
    note TEXT,
    hit_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    last_hit_at TEXT
  )`);

  // GitHub Dependabot Alerts (Phase 0.5, 2026-04-25)
  db.exec(`CREATE TABLE IF NOT EXISTS gh_dependabot_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_full_name TEXT NOT NULL,
    alert_number INTEGER NOT NULL,
    state TEXT NOT NULL,
    severity TEXT,
    package_name TEXT,
    package_ecosystem TEXT,
    cve_id TEXT,
    ghsa_id TEXT,
    summary TEXT,
    html_url TEXT,
    fixed_in TEXT,
    dismissed_reason TEXT,
    auto_dismissed_at TEXT,
    fetched_at TEXT DEFAULT (datetime('now','localtime')),
    raw_json TEXT,
    UNIQUE(repo_full_name, alert_number)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gh_dep_state ON gh_dependabot_alerts(state, severity)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gh_dep_repo ON gh_dependabot_alerts(repo_full_name, state)`);

  // Tool Findings (Phase 1.1: Semgrep/Trivy/Gitleaks/ESLint/Dependabot Aggregation)
  db.exec(`CREATE TABLE IF NOT EXISTS tool_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_full_name TEXT NOT NULL,
    sha TEXT NOT NULL,
    tool TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line_no INTEGER NOT NULL DEFAULT 0,
    tool_severity TEXT,
    message TEXT,
    raw_json TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    ai_severity TEXT,
    ai_confidence REAL,
    ai_reason TEXT,
    ai_suggested_fix TEXT,
    last_seen_at TEXT DEFAULT (datetime('now','localtime')),
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(repo_full_name, sha, tool, rule_id, file_path, line_no)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_findings_repo_sha ON tool_findings(repo_full_name, sha)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_findings_status_sev ON tool_findings(status, ai_severity)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_findings_last_seen ON tool_findings(last_seen_at)`);

  // Graceful Shutdown
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  console.log('[CRA/DB] Schema OK — 22 Tabellen');
  return db;
}

function gracefulShutdown() {
  if (db) {
    try { db.close(); } catch (e) {}
    console.log('[CRA/DB] Geschlossen (WAL checkpoint). Beende.');
  }
  process.exit(0);
}

// ── saveCraDb — No-Op (Kompatibilitaet mit 50+ bestehenden Aufrufen) ────────
// better-sqlite3 schreibt sofort auf Disk via WAL — kein manuelles Save noetig.
function saveCraDb() {
  // No-Op. better-sqlite3 persistiert Writes automatisch.
}

// ── Query Helpers ────────────────────────────────────────────────
// API-kompatibel mit der alten sql.js Version.
// Unterschied: better-sqlite3 nutzt .run(...params) statt .run(sql, [params])

function run(sql, params) {
  if (!db) return;
  try {
    var stmt = db.prepare(sql);
    return params && params.length ? stmt.run.apply(stmt, params) : stmt.run();
  } catch (e) {
    console.error('[CRA/DB] Run error:', sql.substring(0, 80), e.message);
    throw e;
  }
}

function get(sql, params) {
  if (!db) throw new Error('DB nicht initialisiert');
  try {
    var stmt = db.prepare(sql);
    return (params && params.length ? stmt.get.apply(stmt, params) : stmt.get()) || null;
  } catch (e) {
    console.error('[CRA/DB] Get error:', sql.substring(0, 80), e.message);
    throw e;
  }
}

function all(sql, params) {
  if (!db) throw new Error('DB nicht initialisiert');
  try {
    var stmt = db.prepare(sql);
    return params && params.length ? stmt.all.apply(stmt, params) : stmt.all();
  } catch (e) {
    console.error('[CRA/DB] All error:', sql.substring(0, 80), e.message);
    throw e;
  }
}

function transaction(fn) {
  if (!db) throw new Error('DB nicht initialisiert');
  var txn = db.transaction(fn);
  return txn();
}

module.exports = { initCraDb, saveCraDb, run, get, all, transaction };
