'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// minimal semgrep runner (requires `semgrep` on $PATH)
function runRule(filePath) {
  const ruleFile = path.join(__dirname, 'rule-arch-07-mtls.semgrep.yaml');
  const cmd = `semgrep --config "${ruleFile}" "${filePath}" --json --quiet --no-git-ignore`;
  try {
    const stdout = execSync(cmd, { encoding: 'utf8' });
    return JSON.parse(stdout).results;
  } catch (e) {
    // semgrep exits != 0 when findings exist, but stdout still contains JSON
    if (e.stdout) return JSON.parse(e.stdout).results;
    throw e;
  }
}

// ---------------------------------------------------------------------------
const tmpFile = path.join(__dirname, '.tmp-test.js');

function assertFinding(code, expectedViolation) {
  fs.writeFileSync(tmpFile, code, 'utf8');
  const findings = runRule(tmpFile);
  fs.unlinkSync(tmpFile);
  const found = findings.some(f => f.check_id === 'arch-07-mtls');
  if (found !== expectedViolation) {
    console.error(
      `ERROR: expected violation=${expectedViolation} but got ${found}\n` +
      `Code: ${code.slice(0, 80)}...`
    );
    process.exit(1);
  }
  // console.log(`✔ ${expectedViolation ? 'BAD' : 'GOOD'} fixture passed`);
}

// ---------------------------------------------------------------------------
// GOOD fixtures – must NOT trigger the rule
const goodFixtures = [
  `fetch("https://api.example.com/data");`,
  `axios.get('https://secure.service/v1/items');`,
  `got("http://localhost:3000/admin");`,
  `undici.request("http://127.0.0.1:8080/health");`,
  `fetch("https://example.com", { cert: require("fs").readFileSync("cert.pem") });`,
  `const url = "http://example.com"; // not a literal`,
  // template literal with https
  `axios.get(\`https://\${HOST}/path\`);`,
];

// BAD fixtures – MUST trigger the rule
const badFixtures = [
  `fetch("http://external.service/api");`,
  `axios.get('http://api.example.com/data');`,
  `got("http://thirdparty.io/endpoint");`,
  `undici.request("http://not-localhost.com");`,
  `fetch("http://subdomain.localhost/data");`,       // not bare localhost
  `axios.post("http://external.example.com", body);`,
  `got.stream("http://streaming.service/video");`,
  // template literal with http://
  `fetch(\`http://\${HOST}/path\`);`,
];

// ---------------------------------------------------------------------------
console.log('Running arch-07-mtls test suite...');
for (const code of goodFixtures) assertFinding(code, false);
for (const code of badFixtures) assertFinding(code, true);
console.log('All arch-07-mtls tests passed.');

// Cleanup in case we were interrupted
try { fs.unlinkSync(tmpFile); } catch (_) {}

// ---------------------------------------------------------------------------
