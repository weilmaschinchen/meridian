# How-to: control LLM cost (Gate 3)

**Prerequisites**

- A running Meridian instance ([Docker Compose](../getting-started/docker-compose.md))
- Optionally an Ollama server and/or DeepSeek/Anthropic API keys

**What you'll have after**

Gate 3 configured to your budget — from $0 (Ollama only, air-gapped) to a hard-capped cloud setup that never exceeds a daily dollar ceiling.

## How the tier router works

Gate 3 tries tiers in this fixed order and uses the first one configured/available:

```
Ollama (local, free) -> DeepSeek (cheap cloud) -> Anthropic (best cloud)
```

You choose the trade-off by which variables you set. If none are set, Gate 3 is effectively skipped and Gates 1+2 still run.

| Variable | Tier | Cost | Egress needed |
|---|---|---|---|
| `OLLAMA_BASE_URL` | Ollama | $0 | No |
| `DEEPSEEK_API_KEY` | DeepSeek | Low | Yes |
| `ANTHROPIC_API_KEY` | Anthropic | Higher | Yes |
| `LLM_DAILY_CAP_USD` | — | Hard ceiling on paid spend/day | — |

## Setup A — $0 / air-gapped (Ollama only)

No cloud, no egress, no spend. Best for regulated/offline environments.

```bash
# .env
OLLAMA_BASE_URL=http://host.docker.internal:11434
# do NOT set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY
```

Pull a model on the Ollama host first, e.g.:

```bash
ollama pull qwen2.5-coder:7b
```

Verify Meridian can reach it by submitting a diff and confirming Gate 3 produces output (not skipped):

```bash
curl -s -X POST http://localhost:3011/api/cra/analyze \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{"repo_name":"t","branch":"x","commit_message":"t","diff":"+++ b/a.js\n+function f(){return 1}\n"}' \
  | jq '.gates.llm.status'
```

Expected (not `"skipped"`):

```json
"pass"
```

## Setup B — cloud with a hard daily cap

Use local Ollama for the bulk, fall back to cloud for hard cases, and cap the paid spend:

```bash
# .env
OLLAMA_BASE_URL=http://host.docker.internal:11434
DEEPSEEK_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
LLM_DAILY_CAP_USD=2.00
```

When the day's paid spend reaches `LLM_DAILY_CAP_USD`, Meridian stops calling paid tiers for the rest of the day. Gates 1 and 2 are unaffected — they are free and always run. Gate 3 falls back to whatever free tier remains (Ollama) once the cap is hit.

!!! tip "Pick a cap you can sleep through"
    Set the cap to the most you are willing to spend on a runaway day (e.g. an agent opening hundreds of PRs). A small cap with Ollama as the floor means cost is bounded *and* you never lose Gate 3 entirely.

## Setup C — cloud only (no Ollama)

If you have no local GPU and accept egress + spend:

```bash
# .env
DEEPSEEK_API_KEY=sk-...
LLM_DAILY_CAP_USD=5.00
# Anthropic optional as a higher-quality fallback
```

DeepSeek-first keeps cost low; add `ANTHROPIC_API_KEY` only if you want the higher-quality tier for the cases DeepSeek's review is weak on.

## Reducing spend without losing coverage

- Run **Ollama locally for pre-commit** (free, fast feedback) and reserve cloud tiers for the **CI gate** (fewer runs, higher stakes).
- Keep diffs small — Gate 3 cost scales with input size.
- Let Gates 1 and 2 do the cheap work; they catch most secrets and structural issues for free, so Gate 3 only reasons about what is left.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Gate 3 always `skipped` | No tier configured / unreachable | Set `OLLAMA_BASE_URL` or an API key; check connectivity |
| Unexpected cloud bill | No cap set | Set `LLM_DAILY_CAP_USD` |
| Gate 3 stops mid-day | Cap reached | Expected; raise the cap or rely on Ollama floor |
| Ollama unreachable from container | `host.docker.internal` on Linux | Add `extra_hosts: ["host.docker.internal:host-gateway"]` or use the host IP |
| Slow analyses | Large local model on CPU | Use a smaller coder model or a GPU host |

Next: [Solo dev scenario](../scenarios/solo-dev.md)

