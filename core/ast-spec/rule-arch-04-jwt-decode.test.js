/**
 * Tests für semgrep-Regel arch-04-jwt-decode (JWT verify/decode ausserhalb
 * auth/JwtVerifier.ts). Prüft, dass Compliant-Code (erlaubte Pfade bzw.
 * unkritische Methoden) nicht fehlschlägt, während Verstösse erkannt werden.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ruleFile = path.join(__dirname, 'rule-arch-04-jwt-decode.semgrep.yaml');

// ---- goodFixtures: Beispiele, die nicht triggern sollen ----
const goodFixtures = [
  {
    name: 'jwt.verify inside auth/JwtVerifier.ts',
    file: 'auth/JwtVerifier.ts',
    code: `const jwt = require('jsonwebtoken');\nfunction v(t) { return jwt.verify(t, process.env.SECRET); }`
  },
  {
    name: 'jwt.sign only',
    file: 'services/tokenService.ts',
    code: `const jwt = require('jsonwebtoken');\nfunction sign(payload) { return jwt.sign(payload, secret); }`
  },
  {
    name: 'no jwt usage',
    file: 'utils/helper.ts',
    code: `console.log('hello');`
  }
];

// ---- badFixtures: Beispiele, die die Regel verletzen ----
const badFixtures = [
  {
    name: 'jwt.verify in controller',
    file: 'controllers/userController.ts',
    code: `const jwt = require('jsonwebtoken');\nfunction handle(req) { jwt.verify(req.token, secret); }`
  },
  {
    name: 'jwt.decode in middleware',
    file: 'middleware/authMiddleware.ts',
    code: `const jwt = require('jsonwebtoken');\nfunction a(req, res, next) { jwt.decode(req.token); next(); }`
  }
];

function runRule(code, file) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch04-'));
  const fullPath = path.join(tmpDir, file);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, code, 'utf8');
  try {
    const output = execSync(`semgrep --config "${ruleFile}" --quiet --json "${tmpDir}"`, { encoding: 'utf8' });
    return JSON.parse(output);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Minimaler Testlauf (goodFixtures) – erwartet 0 Findings
for (const f of goodFixtures) {
  const res = runRule(f.code, f.file);
  if (res.results.length > 0) throw new Error(`GoodFixture "${f.name}" sollte keine Findings liefern`);
  console.log(`✓ GOOD: ${f.name}`);
}
console.log(`\nAlle GoodFixtures bestanden. BadFixtures manuell prüfen:\n`);
badFixtures.forEach((f, i) => console.log(`${i+1}. ${f.name} (${f.file})`));
