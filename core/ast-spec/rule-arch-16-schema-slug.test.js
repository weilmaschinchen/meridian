// rule-arch-16-schema-slug.test.js
// Test-Skelett für Tenant-Schema-Slug-Validation

const assert = require('assert');

// Simulierte Regel (entspricht Semgrep-Rule arch-16-schema-slug)
const VALID_PATTERN = /^tenant_[a-z0-9_]+$/;
const RESERVED = ['tenant_platform', 'tenant_staging', 'tenant_test', 'tenant_system', 'tenant_mysql'];

function runRule(code) {
  // Extrahiere Schema-Name aus CREATE SCHEMA-Anweisungen
  const schemaMatch = code.match(/CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\S+)[`"']?/i);
  if (!schemaMatch) return [];
  const schemaName = schemaMatch[1].replace(/^["`']|["`']$/g, '');
  const violations = [];
  if (RESERVED.includes(schemaName)) {
    violations.push(`Reservierter Schema-Name: ${schemaName}`);
  } else if (!VALID_PATTERN.test(schemaName)) {
    violations.push(`Ungültiges Schema-Slug-Format: ${schemaName} (Pattern: tenant_[a-z0-9_]+)`);
  }
  return violations;
}

// Good Fixtures (compliant code)
const goodFixtures = [
  "CREATE SCHEMA tenant_easyrider",
  "CREATE SCHEMA IF NOT EXISTS tenant_motovation_2025",
  "CREATE SCHEMA tenant_kunde123",
];

// Bad Fixtures (rule violations)
const badFixtures = [
  "CREATE SCHEMA tenant_platform",          // reserviert
  "CREATE SCHEMA tenant_staging",           // reserviert
  "CREATE SCHEMA IF NOT EXISTS tenant_test",// reserviert
  "CREATE SCHEMA Tenant_Moto" ,            // uppercase
  "CREATE SCHEMA tenant_moto-kompass",      // Bindestrich
  "CREATE SCHEMA tenant_",                  // leer nach Prefix
];

goodFixtures.forEach((code, idx) => {
  assert.deepStrictEqual(runRule(code), [], `Good fixture ${idx} should be clean: ${code}`);
});

badFixtures.forEach((code, idx) => {
  const result = runRule(code);
  assert.ok(result.length > 0, `Bad fixture ${idx} should have violations: ${code}`);
});
