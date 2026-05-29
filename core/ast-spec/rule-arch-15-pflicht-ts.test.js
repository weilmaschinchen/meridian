// Test-Skeleton für Arch-15: Pflicht-TS-File als .js (ADR-0027)
const assert = require('assert');

// Gute Pfade – alle .ts – dürfen nicht beanstandet werden
const goodPaths = [
  'modules/user/port.ts',
  'modules/user/domain/types.ts',
  'modules/user/infrastructure/repository.ts',
  'modules/user/policies/auth.ts',
  'modules/user/index.ts',
];

// Schlechte Pfade – .js anstelle von .ts – müssen beanstandet werden
const badPaths = [
  'modules/user/port.js',
  'modules/user/domain/types.js',
  'modules/user/infrastructure/repository.js',
  'modules/user/policies/auth.js',
  'modules/user/index.js',
];

// Pseudo runRule: simuliert den CRA-Detector (pfadbasiert)
function runRule(filePath) {
  const forbiddenPatterns = [
    /^modules\/[^/]+\/port\.js$/,
    /^modules\/[^/]+\/domain\/types\.js$/,
    /^modules\/[^/]+\/infrastructure\/repository\.js$/,
    /^modules\/[^/]+\/policies\/[^/]+\.js$/,
    /^modules\/[^/]+\/index\.js$/,
  ];
  return forbiddenPatterns.some((pattern) => pattern.test(filePath));
}

// Tests
goodPaths.forEach((p) => {
  assert.strictEqual(runRule(p), false, `Good path ${p} should not be flagged`);
});
badPaths.forEach((p) => {
  assert.strictEqual(runRule(p), true, `Bad path ${p} must be flagged`);
});

console.log('Arch-15 Pflicht-TS file-as-js tests passed.');
