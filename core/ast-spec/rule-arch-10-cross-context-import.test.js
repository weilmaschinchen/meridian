// SPDX-License-Identifier: Apache-2.0
/*
 * Test skeleton for arch-10-cross-context-import
 * Run via Semgrep or a custom parser.
 * Use: node rule-arch-10-cross-context-import.test.js
 */

// Placeholder: real implementation would run Semgrep on the code
function runRule(code) {
  // TODO: integrate Semgrep or custom regex checker
  // For now, return true if code likely contains a cross-context import without port/index.
  return false;
}

const GOOD_FIXTURES = [
  // Import in index.ts re-exporting (allowed)
  {
    name: 'index.ts re-export cross-context',
    code: `export { CourseService } from '../course/domain/CourseService';`,
    file: 'port/index.ts',
  },
  // Import using ../ within same context (not detected)
  {
    name: 'relative import within context',
    code: `import { helper } from '../utils/helper';`,
    file: 'moduleA/domain/service.ts',
  },
];

const BAD_FIXTURES = [
  // Cross-context import in non-port file
  {
    name: 'cross-context import in domain service',
    code: `import { CourseRepo } from '../course/infrastructure/CourseRepo';`,
    file: 'moduleB/domain/service.ts',
  },
];

function test(describe, cases, expectPass) {
  cases.forEach(({ name, code, file }) => {
    const result = runRule(code);
    console.assert(result === expectPass, `${describe} - ${name} FAILED`);
  });
}

test('GOOD', GOOD_FIXTURES, false);  // good fixtures should NOT trigger rule
test('BAD', BAD_FIXTURES, true);   // bad fixtures SHOULD trigger rule
