# Your first analysis

**Prerequisites**

- A running Meridian instance ([Docker Compose](docker-compose.md)) with a healthy `/api/cra/health`
- `curl` and `jq` (jq is optional but used in examples)
- If `MERIDIAN_AUTH_ENABLED=true`, the `CRA_API_TOKEN` value

**What you'll have after**

You will have submitted a diff, watched Meridian open an RFC, and read back its verdict — once for a clean change (`APPROVED`) and once for a risky one (`BLOCKED`).

## Step 1 — Submit a clean diff

Meridian's analyze endpoint takes the diff plus a little metadata. Here is a minimal, harmless change:

```bash
curl -s -X POST http://localhost:3011/api/cra/analyze \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{
    "repo_name": "demo",
    "branch": "main",
    "commit_message": "docs: fix typo in README",
    "diff": "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Helo\n+# Hello\n"
  }' | jq
```

Expected (abridged):

```json
{
  "rfc_id": "rfc_01HX...",
  "diff_hash": "9f2c...",
  "overall_status": "APPROVED",
  "gates": {
    "risk":  { "status": "pass", "findings": [] },
    "ast":   { "status": "pass", "findings": [] },
    "llm":   { "status": "pass", "findings": [] }
  }
}
```

Note the `rfc_id` and `diff_hash` — both identify this exact change.

## Step 2 — Read the RFC back

```bash
curl -s http://localhost:3011/api/cra/rfc/rfc_01HX... \
  -H "Authorization: Bearer $CRA_API_TOKEN" | jq '.overall_status'
```

Expected:

```json
"APPROVED"
```

!!! tip "Always read the status back"
    Do not assume the POST response is the final word — for longer diffs analysis may still be in progress (`DRAFT`). Poll `GET /api/cra/rfc/<id>` until `overall_status` is terminal (`APPROVED`, `BLOCKED`, or `OVERRIDDEN`).

## Step 3 — Submit a risky diff and watch it block

This diff hardcodes a secret and shells out with interpolated input — Gate 1 and/or Gate 2 should fire:

```bash
curl -s -X POST http://localhost:3011/api/cra/analyze \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{
    "repo_name": "demo",
    "branch": "feature/x",
    "commit_message": "add deploy helper",
    "diff": "--- a/deploy.js\n+++ b/deploy.js\n@@\n+const AWS_SECRET = \"AKIAIOSFODNN7EXAMPLE\";\n+require(\"child_process\").exec(\"rm -rf \" + req.query.path);\n"
  }' | jq
```

Expected (abridged):

```json
{
  "rfc_id": "rfc_01HY...",
  "overall_status": "BLOCKED",
  "gates": {
    "risk": {
      "status": "fail",
      "findings": [
        { "id": "secret-aws-access-key", "severity": "critical", "line": 1 },
        { "id": "vuln-command-injection", "severity": "high", "line": 2 }
      ]
    }
  }
}
```

This RFC is now `BLOCKED`. A CI/pre-receive gate keyed on this RFC would refuse the change.

## Step 4 — Decide what to do with a block

You have two honest options:

1. **Fix the code** and submit the new diff (a new RFC).
2. **Override** the block with a recorded reason, if it is a false positive or an accepted risk. See [Block and override](../how-to/block-and-override.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 Unauthorized` | Auth on but token missing/wrong | Send `Authorization: Bearer $CRA_API_TOKEN` |
| `overall_status` stays `DRAFT` | Analysis still running (Gate 3 slow) | Poll `GET /api/cra/rfc/<id>`; check LLM tier reachability |
| Clean diff returns `BLOCKED` | An overly broad custom rule in `MERIDIAN_RULES_PATH` | Review your rules; see [Rules schema](../configuration/rules-schema.md) |
| `400 Bad Request` | Malformed JSON / unescaped newlines in `diff` | Ensure `diff` is a JSON string with `\n` escapes |

Next: [Health check in depth](health-check.md) or [wire it into CI](../integrations/github.md).

