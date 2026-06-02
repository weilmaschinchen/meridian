# API endpoints reference

All endpoints are under `/api/cra/`. When `MERIDIAN_AUTH_ENABLED=true`, every endpoint except `/api/cra/health` requires `Authorization: Bearer <CRA_API_TOKEN>`.

Base URL in examples: `http://localhost:3011`.

## `GET /api/cra/health`

Liveness/readiness probe. Unauthenticated.

```bash
curl -s http://localhost:3011/api/cra/health
```

```json
{"status":"ok"}
```

## `POST /api/cra/analyze`

Submit a diff for analysis. Creates an RFC and runs the 3-gate pipeline.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `repo_name` | string | yes | Repository identifier. |
| `branch` | string | yes | Branch name. |
| `commit_message` | string | yes | Commit/change message. |
| `diff` | string | yes | Unified diff of the change. |

```bash
curl -s -X POST http://localhost:3011/api/cra/analyze \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{
    "repo_name": "demo",
    "branch": "main",
    "commit_message": "add login route",
    "diff": "--- a/auth.js\n+++ b/auth.js\n@@\n+app.post(\"/login\", (req,res)=>{});\n"
  }'
```

**Response (abridged)**

```json
{
  "rfc_id": "rfc_01HX...",
  "diff_hash": "9f2c...",
  "overall_status": "BLOCKED",
  "gates": {
    "risk": { "status": "pass|fail", "findings": [] },
    "ast":  { "status": "pass|fail", "findings": [] },
    "llm":  { "status": "pass|fail|skipped", "findings": [] }
  }
}
```

!!! note
    `analyze` does **not** post a VCS status check. For push-event flows that drive status, use the webhook endpoint below. Always read the status back via `GET /api/cra/rfc/<id>` in case analysis is still `DRAFT`.

## `GET /api/cra/rfc/<rfc_id>`

Retrieve a single RFC: its state, gate findings, and override history.

```bash
curl -s http://localhost:3011/api/cra/rfc/rfc_01HX... \
  -H "Authorization: Bearer $CRA_API_TOKEN" | jq
```

```json
{
  "rfc_id": "rfc_01HX...",
  "repo_name": "demo",
  "branch": "main",
  "diff_hash": "9f2c...",
  "overall_status": "BLOCKED",
  "gates": {
    "risk": { "status": "fail", "findings": [ { "id": "...", "severity": "high", "message": "..." } ] },
    "ast":  { "status": "pass", "findings": [] },
    "llm":  { "status": "pass", "findings": [] }
  },
  "override": null
}
```

Useful one-liner to poll until terminal:

```bash
curl -s http://localhost:3011/api/cra/rfc/rfc_01HX... \
  -H "Authorization: Bearer $CRA_API_TOKEN" | jq -r '.overall_status'
```

## `POST /api/cra/rfc/<rfc_id>/override`

Record an override on a `BLOCKED` RFC. Moves it to `OVERRIDDEN` and writes the act to the audit trail.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `actor` | string | yes | Who is overriding (name/email/identity). |
| `reason` | string | yes | Why the block is accepted. This is permanent record. |

```bash
curl -s -X POST http://localhost:3011/api/cra/rfc/rfc_01HX.../override \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{"actor":"alice@example.com","reason":"False positive: input is a validated enum (see middleware/validate.js)."}'
```

```json
{ "rfc_id": "rfc_01HX...", "overall_status": "OVERRIDDEN", "override": { "actor": "alice@example.com", "reason": "..." } }
```

## `POST /api/cra/webhook`

VCS push-event entry point (Forgejo/Gitea/GitHub push events). Use this for push-driven analysis and any status integration; see [Forgejo](../integrations/forgejo.md) and [GitHub](../integrations/github.md).

```bash
# Configured in your VCS as the webhook target; not normally called by hand.
# POST <push payload> -> 200
```

## Status codes

| Code | Meaning |
|---|---|
| `200` | Success |
| `400` | Malformed request (e.g. invalid JSON, missing field) |
| `401` | Auth enabled and token missing/invalid |
| `403` | Caller not authorized for the action (e.g. override) |
| `404` | RFC id not found |

Next: [AST rules catalog](ast-rules-catalog.md)

