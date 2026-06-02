# Rules schema (`MERIDIAN_RULES_PATH`)

Gate 1 (Risk Assessment) is a regex pattern scan. In addition to its built-in patterns, you can supply your own via a JSON file pointed to by `MERIDIAN_RULES_PATH`. Your patterns are **merged** with the built-ins, not replacing them.

## File shape

The file is a single JSON object with up to three arrays:

```json
{
  "risk_patterns": [],
  "secret_patterns": [],
  "vuln_patterns": []
}
```

All three are optional, but the file must be valid JSON. An invalid file will prevent your custom rules from loading — verify with a known diff after editing.

## Pattern object

Each entry in any of the three arrays is an object:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Stable, unique identifier reported in findings, e.g. `secret-internal-token`. |
| `pattern` | string | yes | A regular expression matched against added lines of the diff. |
| `severity` | string | yes | One of `critical`, `high`, `medium`, `low`. |
| `message` | string | yes | Human-readable explanation shown in the finding. |
| `description` | string | no | Longer rationale / remediation hint. |

!!! tip "Naming convention matters"
    Give detection rules names that clearly mark them as detectors (for example ending in `-pattern`/`-patterns` semantics in surrounding files), so that a self-scanning gate does not flag its own rule definitions as findings. Keep `id` values descriptive and prefixed by category (`secret-`, `vuln-`, `risk-`).

## The three categories

| Array | Use for | Typical severity |
|---|---|---|
| `secret_patterns` | Credentials, tokens, keys that must never appear in a diff | `critical` |
| `vuln_patterns` | Dangerous code constructs (command injection, unsafe deserialization, `eval`) | `high` |
| `risk_patterns` | Policy / hygiene concerns that should be reviewed but are less severe | `medium` / `low` |

They behave identically at runtime; the split is for clarity and reporting.

## Complete example

```json
{
  "secret_patterns": [
    {
      "id": "secret-internal-service-token",
      "pattern": "INTERNAL_SVC_TOKEN\\s*=\\s*['\"][A-Za-z0-9_-]{20,}['\"]",
      "severity": "critical",
      "message": "Hardcoded internal service token detected",
      "description": "Move the token to an environment variable or secrets manager. Never commit it."
    },
    {
      "id": "secret-private-key-block",
      "pattern": "-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----",
      "severity": "critical",
      "message": "Private key material committed in diff"
    }
  ],
  "vuln_patterns": [
    {
      "id": "vuln-node-exec-interpolation",
      "pattern": "child_process\\.(exec|execSync)\\([^)]*\\$\\{?[A-Za-z_]",
      "severity": "high",
      "message": "Possible command injection via interpolated child_process call"
    },
    {
      "id": "vuln-python-yaml-load",
      "pattern": "yaml\\.load\\((?!.*Loader\\s*=\\s*yaml\\.SafeLoader)",
      "severity": "high",
      "message": "Unsafe yaml.load without SafeLoader"
    }
  ],
  "risk_patterns": [
    {
      "id": "risk-todo-security",
      "pattern": "(?i)//\\s*TODO[:\\s].*(security|auth|encrypt)",
      "severity": "low",
      "message": "Security-related TODO left in code"
    },
    {
      "id": "risk-disable-tls-verify",
      "pattern": "rejectUnauthorized\\s*:\\s*false|verify\\s*=\\s*False",
      "severity": "medium",
      "message": "TLS certificate verification disabled"
    }
  ]
}
```

## Wiring it up

```bash
# .env
MERIDIAN_RULES_PATH=/config/rules.json
```

Mount the file into the container and restart:

```yaml
services:
  meridian:
    volumes:
      - ./rules.json:/config/rules.json:ro
    environment:
      - MERIDIAN_RULES_PATH=/config/rules.json
```

```bash
docker compose up -d
```

## Verifying your rules

Submit a diff that should trip a new rule and confirm the finding `id` appears:

```bash
curl -s -X POST http://localhost:3011/api/cra/analyze \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{"repo_name":"t","branch":"x","commit_message":"t","diff":"+++ b/a.js\n+const x = { rejectUnauthorized: false };\n"}' \
  | jq '.gates.risk.findings[].id'
```

Expected to include:

```json
"risk-disable-tls-verify"
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Custom rules never fire | File not loaded | Check `MERIDIAN_RULES_PATH` is set and the path is readable inside the container |
| All analyses error | Invalid JSON in rules file | Validate with `jq . rules.json`; fix syntax |
| Too many false positives | Pattern too broad | Anchor the regex, narrow the character classes, lower the severity |
| Regex never matches | Diff-line scoping | Patterns match added lines; make sure you test against `+`-prefixed content |

Next: [Custom risk rules walkthrough](../external-patterns/custom-risk-rules.md)

