// SPDX-License-Identifier: Apache-2.0
/**
 * Test skeleton for arch-03-cross-tenant-join rule.
 * 
 * In production this would run semgrep via CLI:
 *   semgrep --config rule-arch-03-cross-tenant-join.semgrep.yaml <file>
 *
 * The pseudo runRule() below uses the same regex logic
 * to provide a self-contained verification.
 */

// Semgrep’s regex (extracted for local testing)
const RULE_REGEX = /(?=.*tenant_([a-z0-9_-]+))(?=.*tenant_(?!\1)[a-z0-9_-]+)/;

/**
 * Simulate rule check on one file content.
 * Returns array of match objects (empty if no violation).
 */
function runRule(content) {
  const findings = [];
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (RULE_REGEX.test(line)) {
      findings.push({ line: idx + 1, message: 'Cross-tenant join detected' });
    }
  });
  return findings;
}

// ─── Good Fixtures (compliant) ──────────────────────────────
const goodFixtures = {
  singleSchemaQuery: `
    db.query("SELECT * FROM tenant_a.users WHERE active = 1");
  `,
  sameSchemaJoin: `
    const sql = \`SELECT o.*, c.name 
                FROM tenant_main.orders o
                JOIN tenant_main.customers c ON o.cid = c.id\`;
  `,
  noTenantPrefix: `
    const q = "SELECT COUNT(*) FROM orders";
  `,
  onlyOneOccurrence: `
    db.execute(\`INSERT INTO tenant_store.audit (msg) VALUES ('ok')\`);
  `,
  placeholderUsage: `
    // Template literal with variable – still only one tenant_ if variable is same
    const schema = 'tenant_prod';
    const sql = \`SELECT * FROM \${schema}.products WHERE price > 10\`;
  `,
};

// ─── Bad Fixtures (violations) ──────────────────────────────
const badFixtures = {
  crossJoinExplicit: `
    db.query("SELECT * FROM tenant_a.orders o JOIN tenant_b.customers c ON o.cid = c.id");
  `,
  crossJoinBackticks: `
    const sql = \`SELECT t1.x, t2.y 
                FROM \`tenant_alpha\`.t1
                INNER JOIN \`tenant_beta\`.t2 ON t1.id = t2.ref\`;
  `,
  multipleTenants: `
    // Three different schemas in one snippet
    const q = "WITH a AS (SELECT * FROM tenant_x.t1), b AS (SELECT * FROM tenant_y.t2) SELECT * FROM a, b, tenant_z.t3";
  `,
};

// ─── Quick sanity (run with `node`) ─────────────────────────
if (require.main === module) {
  console.log('=== Good Fixtures ===');
  Object.entries(goodFixtures).forEach(([name, code]) => {
    const matches = runRule(code);
    console.log(`${name}: ${matches.length === 0 ? '✅ OK' : '❌ UNEXPECTED FINDINGS'}`);
  });

  console.log('\n=== Bad Fixtures ===');
  Object.entries(badFixtures).forEach(([name, code]) => {
    const matches = runRule(code);
    console.log(`${name}: ${matches.length > 0 ? '✅ FOUND' : '❌ NOT DETECTED'}`);
  });
}

module.exports = { goodFixtures, badFixtures, runRule };
