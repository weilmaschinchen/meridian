# Environment variable reference

Meridian is configured entirely through environment variables. Set them in your `.env` file or your orchestrator. Unset optional variables fall back to the defaults shown.

## Core / server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3011` | TCP port the HTTP server listens on. |
| `DB_PATH` | `./meridian.db` | Path to the RFC database file. Map a volume here so RFCs persist across restarts. |

## Authentication

| Variable | Default | Description |
|---|---|---|
| `MERIDIAN_AUTH_ENABLED` | `false` | When `true`, all endpoints except `/api/cra/health` require a bearer token. Enable this whenever Meridian is reachable beyond localhost. |
| `CRA_API_TOKEN` | _(unset)_ | The bearer token clients must send as `Authorization: Bearer <token>`. Use a long, random value. Required when auth is enabled. |

## Rules and extensibility

| Variable | Default | Description |
|---|---|---|
| `MERIDIAN_RULES_PATH` | _(unset)_ | Path to a JSON file of external rules (`risk_patterns[]`, `secret_patterns[]`, `vuln_patterns[]`) merged into Gate 1. See [Rules schema](rules-schema.md). |
| `MERIDIAN_PLUGINS` | _(unset)_ | Comma-separated list of plugin module names to load. See [Plugin authoring](../external-patterns/plugin-authoring.md). |
| `MERIDIAN_PLUGINS_DIR` | _(unset)_ | Directory Meridian resolves plugin modules from. |

!!! warning "No `MERIDIAN_AST_RULES_DIR` yet"
    There is **no** environment variable to load custom Semgrep/AST rules from an external directory. Custom AST rules currently require adding `.semgrep.yaml` files to `meridian/core/ast-spec/` (build-time) or shipping them via a plugin. See [Custom AST rules](../external-patterns/custom-ast-rules.md) and [Gaps and roadmap](../external-patterns/gaps-and-roadmap.md).

## LLM review (Gate 3)

The LLM tier router tries the configured tiers in order: **Ollama → DeepSeek → Anthropic**. Configure only the tiers you want; if none are set, Gate 3 is effectively skipped and Gates 1+2 still run.

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_BASE_URL` | _(unset)_ | Base URL of a local Ollama server, e.g. `http://host.docker.internal:11434`. Free and air-gap friendly. Tried first. |
| `DEEPSEEK_API_KEY` | _(unset)_ | API key for the DeepSeek tier (cheap cloud fallback). |
| `ANTHROPIC_API_KEY` | _(unset)_ | API key for the Anthropic tier (highest quality fallback). |
| `LLM_DAILY_CAP_USD` | _(unset / no cap)_ | Hard daily spend ceiling in USD across paid tiers. When reached, Meridian stops calling paid tiers for the rest of the day. Set this to bound cost. |

## Audit trail (WORM)

| Variable | Default | Description |
|---|---|---|
| `CRA_MINIO_ENDPOINT` | _(unset)_ | Endpoint of an S3-compatible store (MinIO, AWS S3, etc.) for the write-once audit trail. When unset, audit records are kept locally only. |

!!! note
    For object-lock / true WORM guarantees, point `CRA_MINIO_ENDPOINT` at a bucket configured with object-lock retention on the storage side. Meridian writes the records; the immutability guarantee is enforced by the bucket policy. See [Regulated scenario](../scenarios/regulated.md).

## Example `.env`

```bash
# Server
PORT=3011
DB_PATH=/data/meridian.db

# Auth (recommended)
MERIDIAN_AUTH_ENABLED=true
CRA_API_TOKEN=please-generate-a-64-char-random-token

# Custom rules
MERIDIAN_RULES_PATH=/config/rules.json

# Plugins
MERIDIAN_PLUGINS=audit-webhook
MERIDIAN_PLUGINS_DIR=/plugins

# LLM tiers (Ollama first = $0; cloud as fallback, capped)
OLLAMA_BASE_URL=http://host.docker.internal:11434
DEEPSEEK_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
LLM_DAILY_CAP_USD=2.00

# Audit trail
CRA_MINIO_ENDPOINT=http://minio:9000
```

Next: [Rules schema](rules-schema.md)



## AST Engine

| Variable | Default | Description |
|----------|---------|-------------|
| `MERIDIAN_AST_ENGINE_URL` | `http://10.89.1.42:3000` | URL of the Gate 2 AST engine. Override when running the engine externally. |
| `MERIDIAN_AST_RULES_PATH` | *(unset)* | Path to a JSON file of custom regex rules. [Docs](../external-patterns/custom-ast-rules.md) |
| `MERIDIAN_AST_RULES_DIR` | *(unset)* | Directory of custom JS rule modules. [Docs](../external-patterns/custom-ast-rules.md) |
