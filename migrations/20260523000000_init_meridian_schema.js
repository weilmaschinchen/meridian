// meridian/migrations/20260523000000_init_meridian_schema.js
// Initiale Meridian-Schema-Migration
// Erstellt: change_records + meridian_config Tabellen
// Die bestehende rfc_runs-Tabelle wird NICHT berührt (additive Migration)

'use strict';

module.exports = {
  description: 'Initiales Meridian-Schema: change_records + meridian_config',

  up: function(db) {
    // Unified Change Record Tabelle
    db.exec(`
      CREATE TABLE IF NOT EXISTS change_records (
        id                    TEXT PRIMARY KEY,
        domain                TEXT NOT NULL DEFAULT 'devops',
        source                TEXT NOT NULL DEFAULT 'api',
        tenant_id             TEXT NOT NULL DEFAULT 'default',
        title                 TEXT NOT NULL,
        description           TEXT,

        change_type           TEXT,
        risk_score            INTEGER DEFAULT 0,
        risk_level            TEXT,
        impact                TEXT,
        urgency               TEXT,
        priority              TEXT,

        status                TEXT NOT NULL DEFAULT 'DRAFT',
        status_change_log     TEXT DEFAULT '[]',
        approved_by           TEXT DEFAULT '[]',
        override_reason       TEXT,

        gate1_status          TEXT,
        gate1_details         TEXT,
        gate2_status          TEXT,
        gate2_details         TEXT,
        gate3_status          TEXT,
        gate3_details         TEXT,
        findings_json         TEXT,
        report_text           TEXT,

        repo_name             TEXT,
        branch                TEXT,
        commit_sha            TEXT,
        diff_hash             TEXT,
        additions             INTEGER DEFAULT 0,
        deletions             INTEGER DEFAULT 0,

        llm_review_status         TEXT,
        llm_review_severity       TEXT,
        llm_review_concerns       TEXT,
        llm_review_by             TEXT,
        llm_review_confidence     REAL,
        llm_review_2nd_status     TEXT,
        llm_review_2nd_severity   TEXT,
        llm_review_2nd_by         TEXT,
        llm_review_2nd_confidence REAL,

        cab_scheduled_at      TEXT,
        change_window_id      TEXT,
        rollback_plan         TEXT,
        pir_notes             TEXT,
        implementation_start  TEXT,
        implementation_end    TEXT,
        approval_ttl_expires  TEXT,

        sla_deadline          TEXT,
        sla_breached          INTEGER DEFAULT 0,
        related_ci_ids        TEXT,
        known_error_id        TEXT,
        workaround            TEXT,
        parent_change_id      TEXT,

        data_classification   TEXT DEFAULT 'internal',
        tokenized             INTEGER DEFAULT 0,
        token_session_id      TEXT,

        related_change_ids    TEXT,
        triggered_by_id       TEXT,
        external_ref          TEXT,
        external_data         TEXT,

        created_at  TEXT DEFAULT (datetime('now','localtime')),
        updated_at  TEXT DEFAULT (datetime('now','localtime'))
      )
    `);

    // Indices für häufige Queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cr_domain   ON change_records(domain);
      CREATE INDEX IF NOT EXISTS idx_cr_status   ON change_records(status);
      CREATE INDEX IF NOT EXISTS idx_cr_tenant   ON change_records(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_cr_repo     ON change_records(repo_name);
      CREATE INDEX IF NOT EXISTS idx_cr_created  ON change_records(created_at DESC);
    `);

    // Meridian-Konfigurationstabelle (Key-Value + JSON)
    db.exec(`
      CREATE TABLE IF NOT EXISTS meridian_config (
        key         TEXT PRIMARY KEY,
        value       TEXT,
        scope       TEXT DEFAULT 'global',
        tenant_id   TEXT DEFAULT 'default',
        changed_by  TEXT,
        changed_at  TEXT DEFAULT (datetime('now','localtime'))
      )
    `);

    // Token-Registry für privacy-filter
    db.exec(`
      CREATE TABLE IF NOT EXISTS token_registry (
        session_id    TEXT NOT NULL,
        token         TEXT NOT NULL,
        original_enc  TEXT NOT NULL,
        field_type    TEXT,
        tenant_id     TEXT DEFAULT 'default',
        expires_at    TEXT,
        PRIMARY KEY (session_id, token)
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tr_expires ON token_registry(expires_at);
    `);

    // Initialen Config-Eintrag setzen
    db.prepare(`
      INSERT OR IGNORE INTO meridian_config (key, value, scope)
      VALUES ('schema_version', '1', 'global')
    `).run();
  },

  down: function(db) {
    db.exec('DROP TABLE IF EXISTS token_registry');
    db.exec('DROP TABLE IF EXISTS meridian_config');
    db.exec('DROP INDEX IF EXISTS idx_cr_domain');
    db.exec('DROP INDEX IF EXISTS idx_cr_status');
    db.exec('DROP INDEX IF EXISTS idx_cr_tenant');
    db.exec('DROP INDEX IF EXISTS idx_cr_repo');
    db.exec('DROP INDEX IF EXISTS idx_cr_created');
    db.exec('DROP TABLE IF EXISTS change_records');
  }
};
