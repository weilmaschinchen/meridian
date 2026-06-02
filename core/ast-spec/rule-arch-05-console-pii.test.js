// SPDX-License-Identifier: Apache-2.0
// rule-arch-05-console-pii.test.js
// Test skeleton for console.log with PII variable.
//
// Replace runRule() with a real invocation of the Semgrep rule
// or the CRA analyzer to validate compliance.

const goodFixtures = [
  // Compliant: no console.log with PII variable
  `console.log("Hello World");`,
  `console.info("User id:", userId);`,               // userId is not in the deny list
  `logger.warn("Failed to send email");`,             // not using console object
  `console.error(email);`                             // console.error is explicitly allowed
];

const badFixtures = [
  // Violation: console.log/info/debug/warn with PII variable
  `console.log(email);`,
  `console.info(phone, user);`,
  `console.debug("Customer:", customer);`,
  `console.warn(token);`,
  `console.log("Password reset for", password);`       // multiple args, one is PII
];

async function runRule(code) {
  // TODO: invoke the rule (e.g. semgrep --config rule-arch-05-console-pii.semgrep.yaml)
  return false;
}

(async () => {
  for (const fixture of goodFixtures) {
    if (await runRule(fixture))
      throw new Error(`Good fixture should NOT trigger: ${fixture}`);
  }
  for (const fixture of badFixtures) {
    if (!await runRule(fixture))
      throw new Error(`Bad fixture SHOULD trigger: ${fixture}`);
  }
  console.log('All checks passed');
})();
