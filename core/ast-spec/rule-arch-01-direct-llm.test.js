// SPDX-License-Identifier: Apache-2.0
// rule-arch-01-direct-llm test skeleton
'use strict';

const assert = require('assert').strict;

/**
 * Pseudo runner: applies the semgrep rule (rule-arch-01-direct-llm-taint)
 * to the given code snippet.
 * In a real test, this would spawn `semgrep` or use a JSON-formatted rule output.
 * For this skeleton, we supply a fake implementation that checks known patterns.
 */
function runRule(code) {
  // extremely naive detection for demonstration; replace with actual semgrep call
  const findings = [];
  if (/process\.env\.\w*KEY\b/.test(code) && /\b(fetch|axios|got|request|superagent|http\.request|https\.request)\s*\(/.test(code)) {
    findings.push({ message: 'Detected env KEY reaching HTTP call' });
  }
  return findings;
}

// -------------------------------------------------------------------
// Good fixtures – complaint code that should produce zero findings
// -------------------------------------------------------------------
const goodFixtures = [
  // KEY used only for non‑HTTP operation
  `const key = process.env.OPENAI_API_KEY;
   console.log(key);`,

  // Non‑KEY env variable used in HTTP call
  `const val = process.env.OTHER_VAR;
   fetch('https://example.com', { headers: { 'X-Value': val } });`,

  // KEY used to set a configuration value, not directly in HTTP call
  `const apiKey = process.env.ANTHROPIC_API_KEY;
   const config = { token: apiKey };
   // ... (config never reaches an HTTP call in this snippet)`
];

// -------------------------------------------------------------------
// Bad fixtures – violations that must be found
// -------------------------------------------------------------------
const badFixtures = [
  // KEY directly passed to fetch
  `const key = process.env.OPENAI_API_KEY;
   fetch('https://api.openai.com/v1/chat/completions', { headers: { Authorization: \`Bearer \${key}\` } });`,

  // KEY passed to axios without intermediate variable
  `axios.post('https://api.anthropic.com/v1/messages', { model: 'claude-3' }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY } });`
];

// Run assertions (only prints, no execution unless invoked by a test runner)
goodFixtures.forEach((code, idx) => assert.strictEqual(runRule(code).length, 0, `goodFixture ${idx} should have 0 findings`));
badFixtures.forEach((code, idx) => assert.ok(runRule(code).length > 0, `badFixture ${idx} should have at least 1 finding`));
