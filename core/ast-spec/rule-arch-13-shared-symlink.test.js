/**
 * rule-arch-13-shared-symlink.test.js
 *
 * Testet die CRA-Regel arch-13: Symlink-Import von shared/ verboten.
 * ADR-0026 §4 — Shared Modules müssen versioniert sein.
 *
 * Verwendung: node admin/cra/ast-spec/rule-arch-13-shared-symlink.test.js
 */

const rule = {
  id: 'arch-13',
  message: 'Symlink-Import von shared/ verboten — nutze versioniertes @example/* npm-Paket.',
  // Regex aus cra-rules.json, ohne diff-spezifischen ^\+.*
  pattern: /(?:from\s+['"`](?:\.{1,2}\/)+shared\/|require\(['"`](?:\.{1,2}\/)+shared\/)/
};

function runRule(code) {
  return rule.pattern.test(code);
}

const goodFixtures = [
  { name: 'import from npm package @example/shared', code: `import { util } from '@example/shared';` },
  { name: 'import from absolute path (no symlink)', code: `import config from '/opt/shared/config.js';` },
  { name: 'require npm package @example/shared', code: `const shared = require('@example/shared');` },
  { name: 'import from same directory (not shared/)', code: `import { helper } from './helpers';` },
  { name: 'import from parent directory but not shared/', code: `import db from '../db/connection';` },
  { name: 'import using template literal (not relative)', code: "const mod = require(`@example/${name}`);" }
];

const badFixtures = [
  { name: 'relativer ESM import von ./shared/', code: `import { x } from './shared/utils';` },
  { name: 'relativer ESM import von ../shared/', code: `import y from '../shared/config';` },
  { name: 'relativer require von ./shared/', code: `const x = require('./shared/helper');` },
  { name: 'relativer require von ../../shared/', code: `const z = require('../../shared/db');` },
  { name: 'relativer import mit backtick', code: 'import { a } from `../shared/logger`;' }
];

// Ausführung
let passed = 0;
let failed = 0;

console.log('Testing good fixtures (sollten NICHT matchen):');
goodFixtures.forEach(f => {
  if (runRule(f.code)) {
    console.error(`  FAIL: ${f.name}`);
    failed++;
  } else {
    console.log(`  PASS: ${f.name}`);
    passed++;
  }
});

console.log('\nTesting bad fixtures (sollten matchen):');
badFixtures.forEach(f => {
  if (runRule(f.code)) {
    console.log(`  PASS: ${f.name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${f.name}`);
    failed++;
  }
});

console.log(`\nErgebnis: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
