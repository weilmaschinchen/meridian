# Claude Code integration

This guide covers two integration depths:

| Mode | What you get | Setup time |
|---|---|---|
| [Pre-commit hook](#pre-commit-hook) | Blocks commits on findings; agent reads findings from stdout | 5 min |
| [MCP server](#mcp-server) | Agent calls Meridian as a native tool; no shell scripts needed | 20 min |

Both modes can coexist — the hook is the backstop, the MCP server is the real-time loop.

---

## Pre-commit hook

The fastest path. A shell script calls Meridian on every `git commit`, blocks if findings exist, and prints them so Claude Code can read and act on them.

### 1 — Create the check script

Add `scripts/meridian-check.sh` to your repository:

```bash
#!/usr/bin/env bash
# scripts/meridian-check.sh
# Runs Meridian on the staged diff. Exit 1 on BLOCKED.
set -euo pipefail

MERIDIAN_URL="${MERIDIAN_URL:-http://localhost:3011}"
TOKEN="${CRA_API_TOKEN:-}"
REPO="${MERIDIAN_REPO:-$(basename "$(git rev-parse --show-toplevel)")}"

DIFF="$(git diff --cached --no-color)"
[ -z "$DIFF" ] && { echo "[meridian] No staged changes, skipping."; exit 0; }
MSG="$(git log -1 --format=%s 2>/dev/null || echo 'wip')"

AUTH_HEADER=""
[ -n "$TOKEN" ] && AUTH_HEADER="-H 'Authorization: Bearer $TOKEN'"

RESP="$(curl -s -X POST "$MERIDIAN_URL/api/cra/analyze" \
  -H "Content-Type: application/json" \
  ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
  --data "$(jq -nc \
    --arg repo   "$REPO" \
    --arg msg    "$MSG" \
    --arg diff   "$DIFF" \
    --arg branch "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)" \
    '{repo_name:$repo, commit_message:$msg, diff:$diff, branch:$branch}')")"

RFC_ID="$(echo "$RESP" | jq -r '.rfc_id // empty')"
STATUS="$(echo "$RESP" | jq -r '.overall_status // "ERROR"')"

# Poll up to 30 s while DRAFT
for _ in $(seq 1 30); do
  [ "$STATUS" = "DRAFT" ] || break
  sleep 1
  STATUS="$(curl -s "$MERIDIAN_URL/api/cra/rfc/$RFC_ID" \
    ${TOKEN:+-H "Authorization: Bearer $TOKEN"} | jq -r '.overall_status // "ERROR"')"
done

if [ "$STATUS" = "APPROVED" ] || [ "$STATUS" = "OVERRIDDEN" ]; then
  echo "[meridian] $STATUS — $RFC_ID"
  exit 0
fi

echo "[meridian] $STATUS — $RFC_ID" >&2
echo "" >&2
echo "Findings:" >&2
echo "$RESP" \
  | jq -r '.gates | to_entries[] | .value.findings[]? |
      "  [\(.severity // "?")] \(.id): \(.message // "")"' >&2
echo "" >&2
echo "Fix the findings above, or open $MERIDIAN_URL/cra to review and override." >&2
exit 1
```

```bash
chmod +x scripts/meridian-check.sh
```

### 2 — Wire as a Git hook

```bash
cat > .git/hooks/pre-commit << 'EOF'
#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/scripts/meridian-check.sh"
EOF
chmod +x .git/hooks/pre-commit
```

For team use, add to a shared `.githooks/` directory and configure with:

```bash
git config core.hooksPath .githooks
```

### 3 — Add CLAUDE.md instructions

Create (or extend) `CLAUDE.md` in the project root so Claude Code knows about the gate:

```markdown
## Change gate — Meridian

Before every commit, `scripts/meridian-check.sh` (registered as `.git/hooks/pre-commit`)
calls Meridian and blocks on findings. Claude Code will see findings printed to stderr.

**When blocked:**
1. Read the findings — each names the exact file/pattern that triggered.
2. Fix the code; re-stage and retry the commit.
3. If you believe it is a false positive, do not skip with `--no-verify`.
   Instead, use the `cra.override` MCP tool with a recorded reason,
   or open the dashboard URL printed in the output.

Never run `git commit --no-verify` to bypass the gate.
```

### 4 — Agentic loop

With the hook in place, Claude Code's agentic loop handles blocking automatically:

```
Claude edits code
  → git add -p / git add <files>
  → git commit          ← pre-commit hook fires
      → Meridian: BLOCKED — [high] vuln-cmd-inject: ...
  ← Claude reads stderr
  → fixes the finding
  → git add <file>
  → git commit          ← fires again
      → Meridian: APPROVED
  → commit succeeds
```

No extra prompting needed — the exit code signals failure; the output tells Claude what to fix.

---

## MCP server

The MCP server gives Claude Code native Meridian tools. Instead of subprocess calls, Claude Code calls `cra.analyze`, `cra.get_rfc`, `cra.prod_check` directly — faster, more structured, and with override capability when the override token is present.

### Prerequisites

- Running Meridian instance with auth enabled
- Node.js 20+
- macOS (for Keychain token storage; see Linux/Windows notes below)

### 1 — Build the MCP server

```bash
# From the Meridian root
cd packages/mcp-cra
npm install
npm run build
```

### 2 — Store tokens in Keychain

```bash
# API token — required for all calls
security add-generic-password \
  -s cra-mcp -a meridian \
  -w "$(read -rsp 'API token: ' t; echo "$t")"

# Override token — optional; omit for read-only agent
security add-generic-password \
  -s cra-mcp-override -a meridian \
  -w "$(read -rsp 'Override token: ' t; echo "$t")"
```

**Linux/Windows:** Export `CRA_MCP_TOKEN` and (optionally) `CRA_MCP_OVERRIDE_TOKEN` as environment variables and rebuild after patching `keychain.ts` to read `process.env`.

### 3 — Register in Claude Code

Global registration (`~/.claude.json`):

```json
{
  "mcpServers": {
    "cra": {
      "command": "node",
      "args": ["/absolute/path/to/meridian/packages/mcp-cra/dist/index.js"],
      "env": {
        "CRA_BASE_URL": "https://meridian.example.com"
      }
    }
  }
}
```

Project-only registration (`.claude/mcp.json` in the project root):

```json
{
  "mcpServers": {
    "cra": {
      "command": "node",
      "args": ["../../meridian/packages/mcp-cra/dist/index.js"],
      "env": {
        "CRA_BASE_URL": "http://localhost:3011"
      }
    }
  }
}
```

Restart Claude Code, then run `/mcp` to verify the `cra` server is connected and the tools appear.

### 4 — Add CLAUDE.md instructions

```markdown
## Change gate — Meridian (MCP)

You have native Meridian tools available via the `cra` MCP server:

- `cra.analyze` — submit a diff for gate analysis; returns findings if BLOCKED
- `cra.get_rfc` — retrieve an RFC by ID (use to poll DRAFT status)
- `cra.list_blockers` — show all blocked RFCs for a repo
- `cra.prod_check` — check if a repo is cleared for production deploy
- `cra.ops_log` — record an operational event (deploy, test run, etc.)
- `cra.start_override_session` — open an override window (requires override token)
- `cra.override` — override a BLOCKED RFC (requires active session)
- `cra.end_session` — close an override session

**Workflow before every commit:**
1. `cra.analyze(diff=<staged diff>, repo_name=<repo>)`
2. If `DRAFT`, poll `cra.get_rfc` until terminal status.
3. If `BLOCKED`, fix findings and re-analyze. Do NOT override without reading findings first.
4. If override is appropriate: open a session with `cra.start_override_session`,
   then call `cra.override` with a concrete justification.

**Before production deploy:**
Always call `cra.prod_check(repo=<repo>)` and stop if `allowed=false`.
```

### 5 — Verify the integration

Ask Claude Code:

> "Run a Meridian check on my staged diff."

Claude Code will call `git diff --cached`, pass the result to `cra.analyze`, and surface any findings inline — no copy-paste required.

---

## Example workflows

### Workflow A — Green path

```
User: "Implement the user search endpoint and commit it."
Claude: edits src/routes/users.js
Claude: git add src/routes/users.js
Claude: cra.analyze(diff=..., repo_name="my-api")
        → { overall_status: "APPROVED", risk_score: 3 }
Claude: git commit -m "feat: user search endpoint"
Claude: "Done. Meridian approved (score 3, no findings)."
```

### Workflow B — Blocked, agent self-corrects

```
User: "Add the admin delete route and commit."
Claude: edits src/routes/admin.js
Claude: cra.analyze(diff=..., repo_name="my-api")
        → BLOCKED
          [high] arch-01: Route /admin/users/:id DELETE — no auth middleware
          [medium] arch-09: Sensitive operation without role check
Claude: fixes src/routes/admin.js  (adds requireAuth, requireRole('admin'))
Claude: cra.analyze(diff=..., repo_name="my-api")
        → APPROVED
Claude: git commit -m "feat: admin delete route with auth"
```

### Workflow C — False positive, recorded override

```
User: "The SQL pattern is a false positive — it is a parameterized query."
Claude: cra.get_rfc(rfc_id="RFC-A31D...")
        → finding: vuln-06-sql-concat, but diff shows pool.query('SELECT ... WHERE id=?', [id])
Claude: cra.start_override_session(
          reason="vuln-06 is FP: query uses parameterized placeholder, not string concat",
          ttl_minutes=15
        )
Claude: cra.override(
          rfc_id="RFC-A31D...",
          reason="Parameterized query confirmed — ? placeholder at line 42, not concatenation"
        )
        → { allowed: true, overall_status: "OVERRIDDEN" }
Claude: git commit -m "feat: ..."
```

### Workflow D — Pre-deploy production check

```
User: "Deploy my-api to production."
Claude: cra.prod_check(repo="my-api")
        → { allowed: false, reason: "RFC RFC-9F2C... is BLOCKED", approveUrl: "..." }
Claude: "Cannot deploy — there is a blocked RFC. Findings: ..."
        "Open https://meridian.example.com/cra#approve-RFC-9F2C... to review."
```

---

## Combined setup (hook + MCP)

Both can run simultaneously. The pre-commit hook acts as a fail-safe for cases where the agent bypasses `cra.analyze` or runs `git commit` directly. The MCP server is the primary integration for agentic loops.

```
Normal agent flow: cra.analyze → fix → cra.analyze → commit
Fallback:          commit → pre-commit hook → BLOCKED → agent reads stderr → fix
Server backstop:   push → pre-receive hook → Meridian polled → denied if BLOCKED
```

The three layers give defense-in-depth: a finding that slips past the MCP check is caught by the local hook, and whatever slips past that is blocked server-side.

---

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `CRA_BASE_URL` | Meridian instance URL | `http://localhost:3011` |
| `CRA_API_TOKEN` | API token for pre-commit script | — |
| `MERIDIAN_URL` | Same as above (used by `meridian-check.sh`) | `http://localhost:3011` |
| `MERIDIAN_REPO` | Override the repository name in the script | git toplevel basename |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/mcp` does not show `cra` | MCP server not registered or failed to start | Check `~/.claude.json` path; run the server manually and watch stderr |
| `Keychain lookup failed` | Token not stored | Re-run `security add-generic-password ...` |
| Tool calls return `ERROR: HTTP 401` | Auth enabled but token wrong | Verify `CRA_API_TOKEN` in Meridian config matches the stored Keychain value |
| Agent does not call `cra.analyze` | No instruction in `CLAUDE.md` | Add the CLAUDE.md block from Step 4 above |
| Override returns `requiresDashboardApproval: true` | Hard-limited finding or Gate 3 FAIL | Go to the `approveUrl` — this is intentional and cannot be bypassed programmatically |
| Pre-commit hook not running | Not executable | `chmod +x .git/hooks/pre-commit` |
| Slow on every commit (Gate 3) | LLM latency on pre-commit | Configure Ollama locally for pre-commit; use cloud tiers in CI only |

---

Next: [MCP tools reference](../reference/mcp-api.md) · [Gate AI-generated code](../how-to/ai-generated-code.md)
