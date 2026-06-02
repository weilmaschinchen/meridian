# Forgejo integration

**Prerequisites**

- A running Meridian instance reachable from your Forgejo server ([Docker Compose](../getting-started/docker-compose.md))
- Admin/SSH access to the Forgejo server (for the pre-receive hook) or repo admin (for the webhook)
- `CRA_API_TOKEN` if `MERIDIAN_AUTH_ENABLED=true`

**What you'll have after**

Forgejo pushes that are analysed by Meridian, with a server-side **pre-receive gate** that *rejects* pushes whose RFC is not `APPROVED`/`OVERRIDDEN`.

## Why pre-receive (not just a webhook)

A webhook tells Meridian about a push *after* it happened — useful for analysis and dashboards but it does not block. The enforcing component is the **pre-receive hook**, which runs on the server before the push is accepted and can reject it. Use both: webhook for visibility, pre-receive for enforcement.

## Path A — webhook (visibility)

1. In Forgejo, go to **Repository → Settings → Webhooks → Add Webhook → Gitea/Forgejo**.
2. Target URL: `https://meridian.internal:3011/api/cra/webhook`
3. HTTP method: `POST`, content type: `application/json`.
4. If auth is enabled, add a header `Authorization: Bearer <CRA_API_TOKEN>` (use the webhook secret/header field).
5. Trigger on **Push events**.
6. Save and use **Test Delivery**. Expected response: `200`.

!!! note
    `/api/cra/webhook` is the push-event entry point. The plain `/api/cra/analyze` endpoint does **not** emit a status check — it just analyses. See [API endpoints](../reference/api-endpoints.md).

## Path B — pre-receive gate (enforcement)

Install a server-side `pre-receive` hook that, for each pushed ref, asks Meridian for the RFC of the pushed diff and exits non-zero unless it is approved.

Example hook (`pre-receive`), to be placed in the repo's hook directory on the Forgejo server:

```bash
#!/usr/bin/env bash
set -euo pipefail

MERIDIAN_URL="https://meridian.internal:3011"
TOKEN="${CRA_API_TOKEN:-}"
REPO_NAME="$(basename "$(pwd)" .git)"

while read -r oldrev newrev refname; do
  branch="${refname#refs/heads/}"
  # Compute the diff for this push
  if [ "$oldrev" = "0000000000000000000000000000000000000000" ]; then
    diff="$(git diff --no-color "$newrev" -- 2>/dev/null || true)"
  else
    diff="$(git diff --no-color "$oldrev" "$newrev")"
  fi
  msg="$(git log -1 --format=%s "$newrev")"

  # Submit and read the verdict
  resp="$(curl -s -X POST "$MERIDIAN_URL/api/cra/analyze" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    --data "$(jq -nc --arg r "$REPO_NAME" --arg b "$branch" --arg m "$msg" --arg d "$diff" \
      '{repo_name:$r, branch:$b, commit_message:$m, diff:$d}')")"

  rfc_id="$(echo "$resp" | jq -r '.rfc_id')"
  status="$(echo "$resp" | jq -r '.overall_status')"

  # Poll until terminal
  for _ in $(seq 1 30); do
    [ "$status" = "DRAFT" ] || break
    sleep 1
    status="$(curl -s "$MERIDIAN_URL/api/cra/rfc/$rfc_id" -H "Authorization: Bearer $TOKEN" | jq -r '.overall_status')"
  done

  case "$status" in
    APPROVED|OVERRIDDEN)
      echo "Meridian: $status ($rfc_id) — push allowed"
      ;;
    *)
      echo "Meridian: $status ($rfc_id) — push REJECTED" >&2
      echo "Review: $MERIDIAN_URL/api/cra/rfc/$rfc_id" >&2
      exit 1
      ;;
  esac
done
```

Make it executable (`chmod +x pre-receive`) and ensure `curl` and `jq` are available on the Forgejo server.

!!! warning "One RFC per push (diff hash)"
    Each push produces an RFC tied to that diff's hash. If you push, then rebase, then push again, that is a **new** RFC — an override of the first does not carry over. The clean workflow: finish locally, rebase, then push **once**; if you hit a false positive, override that exact RFC, no re-push needed.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Webhook test returns `401` | Auth header missing | Add `Authorization: Bearer <token>` to the webhook |
| Pre-receive always rejects | Status stuck at `DRAFT` (LLM slow/unreachable) | Increase poll loop; verify Gate 3 tier; consider Ollama-only for speed |
| Pre-receive allows everything | Hook not installed or not executable | Confirm location and `chmod +x`; check server logs |
| Override didn't unblock the push | Re-pushed a different diff | Override the RFC matching the *current* diff hash; push once |
| `jq: command not found` on server | Missing dependency | Install `jq` on the Forgejo host |

Next: [GitHub integration](github.md)

