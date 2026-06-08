# API endpoints reference

All endpoints live under `/api/cra/`. When `MERIDIAN_AUTH_ENABLED=true`, requests must carry a bearer token unless noted otherwise. See [Authentication & RBAC](auth.md) for the full auth model.

Base URL in examples: `http://localhost:3011`

---

## Health

### `GET /api/cra/health`

Liveness/readiness probe. Unauthenticated. Safe for Kubernetes/Docker health checks.

```bash
curl -s http://localhost:3011/api/cra/health
# → {"status":"ok"}
```

What it does **not** check: LLM tier availability, MinIO/S3 reachability, custom rule parsing errors. Use `/api/cra/dispatcher/status` for a deeper view.

---

## RFC lifecycle

### `POST /api/cra/analyze`

Submit a diff for analysis. Creates an RFC and runs the 3-gate pipeline (risk patterns → AST → LLM). Returns immediately; status may be `DRAFT` if Gate 3 is still running — poll `GET /api/cra/rfc/<id>` for terminal status.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `repo_name` | string | yes | Repository identifier |
| `branch` | string | yes | Branch being changed |
| `commit_message` | string | yes | Commit or change description |
| `diff` | string | yes | Unified diff (`git diff --cached`) |
| `diffSource` | `local` \| `pre-commit` \| `github-pr` \| `github-compare` | no | Origin of the diff |
| `commitSha` | string | no | Commit SHA (for VCS status posting) |
| `repoFullName` | string | no | `owner/repo` form (for GitHub status) |
| `postGithubStatus` | boolean | no | Post a commit status to GitHub |

```bash
curl -s -X POST http://localhost:3011/api/cra/analyze \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{
    "repo_name": "my-api",
    "branch":    "feature/login",
    "commit_message": "add login route",
    "diff": "--- a/auth.js\n+++ b/auth.js\n@@\n+app.post(\"/login\",(req,res)=>{});\n"
  }'
```

**Response**

```json
{
  "rfc_id": "RFC-9F2C4A1B",
  "diff_hash": "9f2c4a1b...",
  "overall_status": "BLOCKED",
  "risk_score": 24,
  "gates": {
    "risk": {
      "status": "fail",
      "findings": [
        { "id": "secret-aws-key", "severity": "critical", "message": "Hardcoded AWS access key" }
      ]
    },
    "ast":  { "status": "pass", "findings": [] },
    "llm":  { "status": "skipped", "findings": [] }
  }
}
```

!!! note
    `analyze` does **not** post a VCS status check by itself. Set `postGithubStatus: true` or use the webhook endpoint for push-driven flows.

---

### `GET /api/cra/rfc/<rfc_id>`

Retrieve a single RFC with its gate results and override history.

```bash
curl -s http://localhost:3011/api/cra/rfc/RFC-9F2C4A1B \
  -H "Authorization: Bearer $CRA_API_TOKEN" | jq
```

**Response**

```json
{
  "rfc_id": "RFC-9F2C4A1B",
  "repo_name": "my-api",
  "branch": "feature/login",
  "commit_message": "add login route",
  "diff_hash": "9f2c4a1b...",
  "overall_status": "BLOCKED",
  "risk_score": 24,
  "created_at": "2026-06-08T10:00:00Z",
  "gates": { ... },
  "override": null
}
```

**Poll until terminal:**

```bash
while true; do
  STATUS=$(curl -s http://localhost:3011/api/cra/rfc/RFC-9F2C4A1B \
    -H "Authorization: Bearer $CRA_API_TOKEN" | jq -r '.overall_status')
  [ "$STATUS" != "DRAFT" ] && break
  sleep 2
done
echo "$STATUS"
```

---

### `GET /api/cra/rfcs`

List the 50 most recent RFCs, sorted by status priority (BLOCKED first).

```bash
curl -s http://localhost:3011/api/cra/rfcs \
  -H "Authorization: Bearer $CRA_API_TOKEN" | jq '.[0:5]'
```

---

### `POST /api/cra/rfc/<rfc_id>/override`

Record an override on a `BLOCKED` RFC. Moves it to `OVERRIDDEN` and writes to the WORM audit trail. Requires the override token (or admin session).

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `actor` | string | yes | Identity of the person overriding |
| `reason` | string | yes | Permanent justification — choose words carefully |

```bash
curl -s -X POST http://localhost:3011/api/cra/rfc/RFC-9F2C4A1B/override \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CRA_OVERRIDE_TOKEN" \
  -d '{
    "actor": "alice@example.com",
    "reason": "False positive — query uses parameterised placeholder, not string concatenation"
  }'
```

**Response**

```json
{ "rfc_id": "RFC-9F2C4A1B", "overall_status": "OVERRIDDEN" }
```

---

### `POST /api/cra/approve/<rfc_id>`

Approve or override an RFC via the dashboard-style flow. Equivalent to `/override` but accepts additional fields used by the dashboard.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | string | yes | Justification |
| `action` | `approve` \| `override` | no | Default: `approve` |
| `force_commit_sha` | string | no | Pin the approval to a specific SHA |
| `force_repo_full_name` | string | no | `owner/repo` used for GitHub status post |

---

### `POST /api/cra/reject/<rfc_id>`

Explicitly mark an RFC as rejected (used by CAB workflow).

**Request body:** `{ "reason": "..." }`

---

### `POST /api/cra/bulk-override`

Override multiple RFCs at once. Requires override token.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | string | yes | Shared justification for all overrides |
| `repo` | string | no | Filter to a specific repo |
| `before_date` | ISO 8601 string | no | Override RFCs created before this date |
| `rfc_ids` | string[] | no | Explicit list of RFC IDs |

---

### `DELETE /api/cra/rfc/<rfc_id>`

Delete an RFC and its approvals. Requires admin session. Irreversible — use only to remove test/erroneous records.

---

## Production readiness

### `GET /api/cra/prod-check/<repo>`

Check whether a repository is cleared for a production deploy. Returns the latest RFC and a deploy decision.

```bash
curl -s "http://localhost:3011/api/cra/prod-check/my-api" \
  -H "Authorization: Bearer $CRA_API_TOKEN" | jq
```

**Response**

```json
{
  "allowed": false,
  "rfcId": "RFC-9F2C4A1B",
  "riskScore": 24,
  "reason": "RFC is BLOCKED — 1 critical finding in Gate 1",
  "approveUrl": "http://localhost:3011/cra#approve-RFC-9F2C4A1B"
}
```

Wire this as the first step of any production deploy script.

---

## Webhooks

### `POST /api/cra/webhook`

Receives push events from VCS providers (Forgejo, Gitea, GitHub, GitLab). Meridian validates the HMAC signature, computes the diff, and triggers the analysis pipeline.

Authentication: **HMAC signature only** (not bearer token). See [Authentication](auth.md#webhook-authentication).

```bash
# Typically configured in VCS settings, not called by hand.
# Payload format: standard GitHub/Forgejo push event JSON
```

### `GET /api/cra/webhook-status/<repo>`

Return the RFC created by the most recent webhook push for a given repository.

---

## Operations log

### `POST /api/cra/ops-log`

Record an operational event that has no code diff — deployment, test run, config change, infrastructure action.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | yes | Short action name, e.g. `deploy-staging` |
| `description` | string | yes | Human-readable detail |
| `command` | string | no | Shell command run (for audit) |
| `repo` | string | no | Associated repository |

```bash
curl -s -X POST http://localhost:3011/api/cra/ops-log \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{
    "action": "deploy-staging",
    "description": "Deployed v1.4.2 to staging for smoke test",
    "repo": "my-api"
  }'
```

---

## Worker task queue

The task queue lets agents (Claude Code, custom bots) pick up remediation tasks and report back. It is the backbone of agentic fix-and-verify loops.

### `GET /api/cra/pending-tasks`

Fetch all tasks that are in `pending` state. **Token-only auth** (session cookies not accepted).

```bash
curl -s http://localhost:3011/api/cra/pending-tasks \
  -H "Authorization: Bearer $CRA_API_TOKEN"
```

**Response**

```json
[
  {
    "taskId": "task_01HX...",
    "findingId": "finding_01HX...",
    "title": "SQL injection in search route",
    "severity": "high",
    "description": "Unsanitised input passed directly to pool.query()",
    "suggestedFix": "Use parameterised query: pool.query('SELECT ... WHERE id=?', [id])",
    "filePath": "src/routes/search.js",
    "lineHint": 42
  }
]
```

### `POST /api/cra/task-status`

Update the status of a task. **Token-only auth**.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | yes | Task ID from `pending-tasks` |
| `status` | `pending` \| `picked` \| `done` \| `failed` | yes | New status |
| `markFixed` | boolean | no | If `true`, also marks the finding as resolved |

```bash
# Mark task as picked up
curl -s -X POST http://localhost:3011/api/cra/task-status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{"taskId":"task_01HX...","status":"picked"}'

# Mark task as done + mark finding fixed
curl -s -X POST http://localhost:3011/api/cra/task-status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{"taskId":"task_01HX...","status":"done","markFixed":true}'
```

### `POST /api/cra/claude-task`

Create a new remediation task from a finding.

**Request body:** `{ "findingId": "finding_01HX..." }`

---

## LLM usage tracking

If you integrate external LLM calls (e.g. your own agents calling Claude or DeepSeek), you can log their costs to the shared Meridian usage tracker.

### `POST /api/cra/usage/log`

**Token-only auth.**

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | string | yes | `anthropic`, `deepseek`, `ollama`, etc. |
| `model` | string | yes | Model ID |
| `input_tokens` | integer | yes | |
| `output_tokens` | integer | yes | |
| `cache_creation_tokens` | integer | no | Anthropic prompt-cache write tokens |
| `cache_read_tokens` | integer | no | Anthropic prompt-cache read tokens |
| `cost_usd` | number | yes | Actual cost in USD |
| `context` | string | no | What the call was for |

### `GET /api/cra/usage/total`

**Query params:** `?hours=24` (default: 24)

Returns total cost and token counts for the window.

### `GET /api/cra/usage/summary`

**Query params:** `?since=YYYY-MM-DD`

Returns daily breakdown by provider and model.

---

## Rules management

### `GET /api/cra/rules`

Return the current rules configuration (risk patterns, secret patterns, vuln patterns, pipeline settings).

### `PUT /api/cra/rules`

Replace the entire rules configuration. Requires admin session. Accepts the same JSON schema as `MERIDIAN_RULES_PATH`. See [Rules schema](../configuration/rules-schema.md).

---

## Status codes

| Code | Meaning |
|---|---|
| `200` | Success |
| `400` | Malformed request (invalid JSON, missing field) |
| `401` | Auth enabled and token missing or invalid |
| `403` | Token valid but insufficient privileges |
| `404` | RFC, finding, or task not found |
| `409` | Conflict (e.g. cycle already closed) |
| `500` | Server error |

**Response envelope:**

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": "descriptive message" }
```

---

## API checklist for agent authors

Before writing a new agent integration against the Meridian API:

- [ ] Read `GET /api/cra/health` first; bail if not `{"status":"ok"}`.
- [ ] Use `MERIDIAN_AUTH_ENABLED=false` only in local dev; always pass a token in CI/prod.
- [ ] After `POST /api/cra/analyze`, poll `GET /api/cra/rfc/<id>` until status is not `DRAFT`.
- [ ] Use `GET /api/cra/pending-tasks` (not your own task store) for work dispatch.
- [ ] Mark tasks `picked` immediately when starting, `done` or `failed` when finished.
- [ ] Check `GET /api/cra/prod-check/<repo>` before any production deploy.
- [ ] Log LLM calls via `POST /api/cra/usage/log` if running your own LLM agents.

---

Next: [MCP tools](mcp-api.md) · [Authentication & RBAC](auth.md) · [AST rules catalog](ast-rules-catalog.md)
