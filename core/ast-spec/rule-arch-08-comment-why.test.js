// SPDX-License-Identifier: Apache-2.0
/**
 * Test skeleton for rule-arch-08-comment-why
 * Demonstrates goodFixtures (comment with Why) vs badFixtures (comment just repeats function name)
 * Pseudo‑runs the rule by applying a simple heuristic (exact comment == function name).
 */

const assert = require('assert');

// ------------------------------------------------------------------
//  Helper: pseudo runRule returns array of violations found.
function runRule(code) {
  const lines = code.split('\n');
  const violations = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    // match single‑line comment // <content> (ignore spaces)
    const m = line.match(/^\/\/\s*(.+)$/);
    if (!m) continue; // not a single‑line comment, skip
    const commentText = m[1].trim();
    // check next line for function declaration
    const next = lines[i + 1].trim();
    const funcMatch = next.match(/^(?:export\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/);
    if (funcMatch) {
      const functionName = funcMatch[1];
      // violation if comment text is exactly the function name (case‑sensitive)
      if (commentText === functionName) {
        violations.push({ line: i + 1, comment: commentText, function: functionName });
      }
    }
  }
  return violations;
}

// ------------------------------------------------------------------
describe('Rule arch-08: comment‑why', () => {

  // --- Good fixtures: comment provides rationale, not just function name
  it('should NOT flag a comment that explains the reason', () => {
    const good = [
      `// Because of auth requirements we must set the user`,
      `function setUser(user) {`,
      `  ...`,
      `}`
    ].join('\n');
    assert.strictEqual(runRule(good).length, 0);
  });

  it('should NOT flag a comment with a “Why” keyword', () => {
    const good = [
      `// The offset is adjusted due to timezone conversion`,
      `function timezoneOffset(date) {`,
      `  ...`,
      `}`
    ].join('\n');
    assert.strictEqual(runRule(good).length, 0);
  });

  // --- Bad fixtures: comment just repeats the function name
  it('should flag when comment is exactly the function name', () => {
    const bad = [
      `// setUser`,
      `function setUser(user) {`,
      `  ...`,
      `}`
    ].join('\n');
    const violations = runRule(bad);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].comment, 'setUser');
    assert.strictEqual(violations[0].function, 'setUser');
  });
});
