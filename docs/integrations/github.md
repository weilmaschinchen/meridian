# GitHub integration

**Prerequisites**

- A running Meridian instance reachable from GitHub Actions runners (self-hosted runner if Meridian is on a private network) ([Docker Compose](../getting-started/docker-compose.md))
- Repo admin to add Actions secrets and (optionally) a webhook
- `CRA_API_TOKEN` stored as a repo/org secret

**What you'll have after**

A GitHub Actions job that submits each PR's diff to Meridian and **fails the check** unless the RFC is `APPROVED`/`OVERRIDDEN`, plus (optionally) a webhook for push-event visibility.

!!! note "Meridian is self-hosted"
    GitHub cannot reach a private Meridian instance directly. Either expose Meridian on a reachable URL with auth enabled, or run a **self-hosted GitHub Actions runner** inside the network where Meridian lives. This is also what makes Meridian usable in environments GHAS cannot serve (air-gapped, on-prem).

## Path A — GitHub Actions PR gate (enforcement)

Add `.github/workflows/meridian.yml`:

```yaml
name: Meridian Gate
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  gate:
    runs-on: ubuntu-latest   # use a self-hosted runner if Meridian is private
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Build diff and submit to Meridian
        env:
          MERIDIAN_URL: ${{ secrets.MERIDIAN_URL }}
          CRA_API_TOKEN: ${{ secrets.CRA_API_TOKEN }}
        run: |
          set -euo pipefail
          BASE="${{ github.event.pull_request.base.sha }}"
          HEAD="${{ github.event.pull_request.head.sha }}"
          DIFF="$(git diff --no-color "$BASE" "$HEAD")"
          MSG="$(git log -1 --format=%s "$HEAD")"

          RESP="$(curl -s -X POST "$MERIDIAN_URL/api/cra/analyze" \
            -H 'Content-Type: application/json' \
            -H "Authorization: Bearer $CRA_API_TOKEN" \
            --data "$(jq -nc \
              --arg r "${{ github.repository }}" \
              --arg b "${{ github.head_ref }}" \
              --arg m "$MSG" \
              --arg d "$DIFF" \
              '{repo_name:$r, branch:$b, commit_message:$m, diff:$d}')")"

          RFC_ID="$(echo "$RESP" | jq -r '.rfc_id')"
          STATUS="$(echo "$RESP" | jq -r '.overall_status')"
          echo "RFC: $RFC_ID  initial status: $STATUS"

          for _ in $(seq 1 30); do
            [ "$STATUS" = "DRAFT" ] || break
            sleep 2
            STATUS="$(curl -s "$MERIDIAN_URL/api/cra/rfc/$RFC_ID" \
              -H "Authorization: Bearer $CRA_API_TOKEN" | jq -r '.overall_status')"
          done

          echo "Final status: $STATUS"
          case "$STATUS" in
            APPROVED|OVERRIDDEN) echo "Gate passed." ;;
            *) echo "::error::Meridian blocked this change ($STATUS) — RFC $RFC_ID"; exit 1 ;;
          esac
```

Add repo secrets:

- `MERIDIAN_URL` — e.g. `https://meridian.example.internal:3011`
- `CRA_API_TOKEN` — matching the instance token

Then make the **Meridian Gate** check **required** under **Settings → Branches → Branch protection rules**. Now a `BLOCKED` RFC fails the required check and the PR cannot merge.

## Path B — webhook (visibility)

1. **Settings → Webhooks → Add webhook**.
2. Payload URL: `https://meridian.example.internal:3011/api/cra/webhook`
3. Content type: `application/json`.
4. Events: **Just the push event**.
5. Add a secret/auth header if auth is enabled.

The webhook gives Meridian push events for analysis/audit; it does not by itself block — branch protection + the Actions check is the enforcement.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Job cannot reach Meridian | Hosted runner can't see private host | Use a self-hosted runner inside the network |
| `jq: command not found` | Minimal runner image | `ubuntu-latest` ships jq; on custom images install it |
| Diff empty | Shallow checkout | `fetch-depth: 0` in `actions/checkout` |
| Check passes but PR still mergeable when blocked | Check not marked required | Add it under branch protection rules |
| `401` from Meridian | Token mismatch | Re-set `CRA_API_TOKEN` secret |

Next: [External Patterns overview](../external-patterns/overview.md)

