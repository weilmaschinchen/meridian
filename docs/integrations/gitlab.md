# GitLab integration

Meridian integrates with GitLab via:

- **Path A — Webhook** (visibility): Every push triggers Meridian analysis; results appear in the Meridian dashboard.
- **Path B — Pre-receive hook** (enforcement): Meridian verdict is polled server-side before a push is accepted. BLOCKED pushes are rejected.

Both paths use the same `POST /api/cra/analyze` endpoint. Only the triggering mechanism differs.

---

## Prerequisites

- A running Meridian instance reachable from your GitLab server (for Path A) or from the Git server process (for Path B).
- `CRA_API_TOKEN` if `MERIDIAN_AUTH_ENABLED=true`.
- For commit-status posting back to GitLab: `MERIDIAN_GITLAB_SECRET`, `MERIDIAN_GITLAB_URL`, `MERIDIAN_GITLAB_API_TOKEN`.

---

## Path A — Webhook (visibility)

GitLab pushes an event to Meridian; Meridian analyses the diff and posts a commit status back.

### 1 — Configure webhook in GitLab

In your project: **Settings → Webhooks → Add new webhook**

| Field | Value |
|---|---|
| URL | `https://meridian.example.com/api/cra/webhook` |
| Secret token | Any random string; store as `MERIDIAN_GITLAB_SECRET` |
| Trigger | Push events |
| SSL verification | Enable (recommended) |

### 2 — Configure Meridian for GitLab

Set these environment variables on your Meridian instance:

```bash
MERIDIAN_GITLAB_SECRET=<your-webhook-secret>
MERIDIAN_GITLAB_URL=https://gitlab.example.com       # or https://gitlab.com
MERIDIAN_GITLAB_API_TOKEN=<personal-or-project-token>
```

The GitLab API token needs: **API scope** (to post commit statuses).

Minimum scopes for a project access token: `api`.

### 3 — Verify

Push a commit to any branch. In Meridian's dashboard you should see a new RFC within seconds. In GitLab, the commit should show a status check named `meridian/cra`.

**Troubleshooting**

| Symptom | Cause | Fix |
|---|---|---|
| Webhook delivers but no RFC | Secret mismatch → 401 | Compare `MERIDIAN_GITLAB_SECRET` with the GitLab webhook secret token field |
| RFC created but no commit status | `MERIDIAN_GITLAB_API_TOKEN` missing or lacks scope | Token needs `api` scope |
| RFC stuck in DRAFT | Gate 3 slow | LLM is still running; poll `GET /api/cra/rfc/<id>` or see [LLM cost control](../how-to/llm-cost-control.md) |

---

## Path B — Pre-receive hook (enforcement)

A server-side Git hook blocks the push if the Meridian verdict is not `APPROVED` or `OVERRIDDEN`. This works for self-managed GitLab; it is not available on GitLab SaaS.

### 1 — Add the pre-receive hook on the Git server

On the GitLab server, locate the repository's Git directory (usually under `/var/opt/gitlab/git-data/repositories/<namespace>/<project>.git`). Create `custom_hooks/pre-receive`:

```bash
#!/usr/bin/env bash
# /var/opt/gitlab/git-data/repositories/<namespace>/<project>.git/custom_hooks/pre-receive
# Blocks pushes that Meridian marks as BLOCKED.

set -euo pipefail

MERIDIAN_URL="${MERIDIAN_URL:-https://meridian.example.com}"
TOKEN="${CRA_API_TOKEN:-}"
REPO="${MERIDIAN_REPO:-my-project}"

while IFS=' ' read -r OLD_SHA NEW_SHA REF; do
  [ "$NEW_SHA" = "0000000000000000000000000000000000000000" ] && continue  # delete

  DIFF="$(git diff --no-color "$OLD_SHA..$NEW_SHA" 2>/dev/null || true)"
  [ -z "$DIFF" ] && continue

  BRANCH="${REF#refs/heads/}"

  RESP="$(curl -s -X POST "$MERIDIAN_URL/api/cra/analyze" \
    -H "Content-Type: application/json" \
    ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
    --data "$(jq -nc \
      --arg repo   "$REPO" \
      --arg branch "$BRANCH" \
      --arg msg    "push to $BRANCH" \
      --arg diff   "$DIFF" \
      '{repo_name:$repo,branch:$branch,commit_message:$msg,diff:$diff}')" \
    --max-time 10)"

  RFC_ID="$(echo "$RESP"  | jq -r '.rfc_id // empty')"
  STATUS="$(echo "$RESP"  | jq -r '.overall_status // "ERROR"')"

  # Poll up to 60 s while DRAFT
  for _ in $(seq 1 60); do
    [ "$STATUS" = "DRAFT" ] || break
    sleep 1
    STATUS="$(curl -s "$MERIDIAN_URL/api/cra/rfc/$RFC_ID" \
      ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
      | jq -r '.overall_status // "ERROR"')"
  done

  if [ "$STATUS" = "APPROVED" ] || [ "$STATUS" = "OVERRIDDEN" ]; then
    echo "[meridian] $STATUS — $RFC_ID"
    continue
  fi

  echo ""
  echo "=================================================" >&2
  echo "[meridian] PUSH REJECTED — RFC $RFC_ID is $STATUS" >&2
  echo "" >&2
  echo "$RESP" | jq -r '.gates | to_entries[] | .value.findings[]? |
      "  [\(.severity)] \(.id): \(.message // "")"' >&2
  echo "" >&2
  echo "Fix findings or open $MERIDIAN_URL/cra to override." >&2
  echo "=================================================" >&2
  exit 1
done
```

```bash
chmod +x /var/opt/gitlab/git-data/repositories/<namespace>/<project>.git/custom_hooks/pre-receive
```

### 2 — Test

Push a clean change — it should pass. Push a change with a hardcoded secret — it should be rejected with the Meridian findings.

### 3 — Fallback behaviour

If Meridian is unreachable (`curl` times out), the hook currently fails open (the push is allowed). To fail closed instead, change the timeout handling:

```bash
RESP="$(curl -s ... --max-time 10)" || {
  echo "[meridian] Gate unreachable — push BLOCKED (fail-closed mode)" >&2
  exit 1
}
```

Choose based on your availability requirements.

---

## Commit status values

When Meridian posts a commit status back to GitLab via the API:

| Meridian status | GitLab state | Description |
|---|---|---|
| `APPROVED` | `success` | All gates passed |
| `OVERRIDDEN` | `success` | Blocked but override recorded |
| `BLOCKED` | `failed` | One or more gates failed |
| `DRAFT` | `pending` | Analysis in progress |

---

## Required GitLab API token scopes

| Use | Minimum scope |
|---|---|
| Post commit statuses | `api` |
| Read MR details | `read_api` |
| Personal access token | `api` (includes `read_api`) |

Store the token as `MERIDIAN_GITLAB_API_TOKEN` in Meridian's environment.

---

## Adapter reference

The GitLab adapter lives at `adapters/gitlab-webhook.js`. It handles:

- **HMAC verification** — validates `X-Gitlab-Token` header against `MERIDIAN_GITLAB_SECRET`
- **Event mapping** — supports Push Hook, Tag Push Hook, Merge Request Hook
- **Status posting** — maps `APPROVED/BLOCKED/OVERRIDDEN/PENDING` to GitLab commit state
- **Health check** — `GET /api/cra/health` used by the adapter to verify GitLab reachability

To call the adapter from custom code:

```javascript
import { ingest, notify, health, validateConfig } from './adapters/gitlab-webhook.js';

// Parse a raw GitLab push event
const changeRecord = ingest(rawPayload, headers);

// Post result back to GitLab
await notify(changeRecord, { status: 'APPROVED' });
```

---

Next: [Forgejo](forgejo.md) · [GitHub](github.md) · [API endpoints](../reference/api-endpoints.md)
