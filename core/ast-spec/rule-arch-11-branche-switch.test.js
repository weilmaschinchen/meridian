// SPDX-License-Identifier: Apache-2.0
/**
 * Testgerüst für rule-arch-11 (tenant.branche-Verzweigungen)
 * Beschreibt goodFixtures (kein Verstoß) + badFixtures (Verstoß)
 * Pseudo-runRule: minimale Regex-Prüfung, die als Platzhalter für die echte Semgrep/TS-Regel dient
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------
// goodFixtures – erlaubter Code (innerhalb policies/ oder kein tenant.branche)
// ---------------------------------------------------------------------
const goodFixtures = [
  {
    filepath: 'src/policies/AcmePolicy.js',
    content: `if (tenant.branche === 'acme') { return discount(0.1); }`
  },
  {
    filepath: 'src/core/Service.js',
    content: `if (tenant.name === 'test') { doStuff(); }`  // kein tenant.branche
  },
  {
    filepath: 'src/policies/Resolver.ts',
    content: `switch (tenant.branche) { case 'foo': break; }`
  }
];

// ---------------------------------------------------------------------
// badFixtures – verbotener Code (tenant.branche ausserhalb policies/)
// ---------------------------------------------------------------------
const badFixtures = [
  {
    filepath: 'src/core/OrderService.js',
    content: `if (tenant.branche === 'premium') { applyPremiumRules(); }`
  },
  {
    filepath: 'src/domain/Calculator.ts',
    content: `const result = tenant.branche === 'basic' ? basicCalc() : standardCalc();`
  },
  {
    filepath: 'src/services/Dispatcher.js',
    content: `switch (tenant.branche) { case 'enterprise': return bigPlan; }`
  }
];

// ---------------------------------------------------------------------
// Pseudo‑runRule: vereinfachte Prüfung auf if/switch mit tenant.branche
// ---------------------------------------------------------------------
function runRule(file) {
  if (file.filepath.includes('/policies/')) return []; // explizit erlaubt
  const lines = file.content.split('\n');
  return lines.filter(line => /\b(if|switch)\s*\([^)]*tenant\.branche/.test(line));
}

// Test (manuelles Ausführen)
console.log('goodFixtures:');
goodFixtures.forEach(f => console.log(runRule(f).length ? 'FEHLER' : 'OK', f.filepath));
console.log('\nbadFixtures:');
badFixtures.forEach(f => {
  const found = runRule(f);
  console.log(found.length > 0 ? `VERSTOSS (${found.length})` : 'NICHT GEFUNDEN', f.filepath);
});
