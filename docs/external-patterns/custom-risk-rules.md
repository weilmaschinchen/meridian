# Custom risk rules

**Prerequisites**

- A running Meridian instance ([Docker Compose](../getting-started/docker-compose.md))
- Ability to mount a file into the container and set `MERIDIAN_RULES_PATH`
- Familiarity with the [Rules schema](../configuration/rules-schema.md)

**What you'll have after**

Your own regex detections running in Gate 1 alongside the built-ins, verified against a test diff.

## Step 1 — Write the rules file

Create `rules.json`. This example adds one secret, one vuln, and one risk pattern:

```json
{
  "secret_patterns": [
    {
      "id": "secret-acme-api-key",
      "pattern": "ACME_API_KEY\\s*=\\s*['\"]ak_[A-Za-z0-9]{24,}['\"]",
      "severity": "critical",
      "message": "Hardcoded ACME API key",
      "description": "Load from env/secrets manager; rotate the leaked key immediately."
    }
  ],
  "vuln_patterns": [
    {
      "id": "vuln-eval-on-request",
      "pattern": "\\beval\\(\\s*req\\.(body|query|params)",
      "severity": "high",
      "message": "eval() on request data — remote code execution risk"
    }
  ],
  "risk_patterns": [
    {
      "id": "risk-console-log-pii",
      "pattern": "console\\.log\\([^)]*(email|ssn|password|token)",
      "severity": "medium",
      "message": "Possible PII/secret logged to stdout"
    }
  ]
}
```

Validate JSON before mounting:

```bash
jq . rules.json >/dev/null && echo "valid"
```

Expected:

```text
valid
```

## Step 2 — Mount and configure

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

## Step 3 — Verify each rule fires

```bash
curl -s -X POST http://localhost:3011/api/cra/analyze \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{
    "repo_name":"t","branch":"x","commit_message":"t",
    "diff":"+++ b/a.js\n+const ACME_API_KEY = \"ak_abcdefghijklmnopqrstuvwx\";\n+eval(req.body.code);\n+console.log(user.email);\n"
  }' | jq '.gates.risk.findings[] | {id, severity}'
```

Expected:

```json
{ "id": "secret-acme-api-key", "severity": "critical" }
{ "id": "vuln-eval-on-request", "severity": "high" }
{ "id": "risk-console-log-pii", "severity": "medium" }
```

The overall RFC should be `BLOCKED`:

```bash
curl -s -X POST ... | jq '.overall_status'
# "BLOCKED"
```

## Writing good regex rules

- **Anchor** where you can (`=`, function-name boundaries `\b`) to cut false positives.
- **Escape** JSON *and* regex backslashes — in JSON a literal `\d` is written `\\d`.
- Match against **added lines**; test with `+`-prefixed content.
- Start with `severity: low/medium` for a new pattern, watch for false positives, then promote.
- Prefer many narrow rules over one giant alternation — findings are then actionable.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Rule never fires | File not loaded | Check `MERIDIAN_RULES_PATH`, container can read the path |
| All analyses fail | Bad JSON | `jq . rules.json`; fix and restart |
| Over-matching | Pattern too greedy | Anchor it; tighten character classes |
| Backslash confusion | Double-escaping | Remember JSON eats one backslash; `\\d` → `\d` in the engine |

Next: [Custom AST rules](custom-ast-rules.md)

