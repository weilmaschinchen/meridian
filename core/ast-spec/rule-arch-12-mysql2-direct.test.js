// SPDX-License-Identifier: Apache-2.0
/**
 * arch-12-mysql2-direct.test.js
 * Test-Skelett für Regel arch-12: mysql2-Import außerhalb infrastructure/
 */

const goodFixtures = [
  {
    path: 'modules/booking/infrastructure/repository.ts',
    code: 'import mysql2 from "mysql2/promise";'
  },
  {
    path: 'modules/booking/domain/booking-service.ts',
    code: 'import { BookingRepository } from "../ports/booking-repository";'
  }
];

const badFixtures = [
  {
    path: 'modules/booking/domain/booking-service.ts',
    code: 'import mysql2 from "mysql2";'
  },
  {
    path: 'some-file.js',
    code: 'const mysql = require("mysql2");'
  }
];

/**
 * Pseudofunktion, die die Semgrep-Regel simuliert.
 * In echter Pipeline wird stattdessen `semgrep --config rule-arch-12-mysql2-direct.semgrep.yaml` ausgeführt.
 */
function runRule(file) {
  const patternImport = /import\s+(?:[\w*\s{},]*\s+from\s+)?['"]mysql2(\/promise)?['"]/g;
  const patternRequire = /=\s*require\(['"]mysql2(\/promise)?['"]\)/g;
  const violation = (patternImport.test(file.code) || patternRequire.test(file.code))
    && !file.path.includes('/infrastructure/');
  return violation ? ['arch-12-mysql2-direct'] : [];
}

// Test-Runner (manuell ausführen oder via Node.js)
console.log('Running tests for arch-12-mysql2-direct...');
let passed = 0;
let failed = 0;

goodFixtures.forEach(f => {
  const result = runRule(f);
  if (result.length === 0) { console.log(`PASS good: ${f.path}`); passed++; }
  else { console.log(`FAIL good ${f.path}: expected no violations, got ${result}`); failed++; }
});

badFixtures.forEach(f => {
  const result = runRule(f);
  if (result.length > 0) { console.log(`PASS bad: ${f.path}`); passed++; }
  else { console.log(`FAIL bad ${f.path}: expected violations, got none`); failed++; }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
