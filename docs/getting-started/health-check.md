# Health check

**Prerequisites**

- A running Meridian instance ([Docker Compose](docker-compose.md))
- `curl`

**What you'll have after**

A reliable way to confirm Meridian is up, plus the exact command to use in a Docker/Kubernetes health probe.

## The endpoint

```bash
curl -s http://localhost:3011/api/cra/health
```

Expected:

```json
{"status":"ok"}
```

A `200` with `"status":"ok"` means the HTTP server is up and the core is initialised. The health endpoint is intentionally unauthenticated so probes do not need a token.

## Use it as a container health probe

In `docker-compose.yml`:

```yaml
services:
  meridian:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3011/api/cra/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

In Kubernetes:

```yaml
livenessProbe:
  httpGet:
    path: /api/cra/health
    port: 3011
  initialDelaySeconds: 20
  periodSeconds: 30
readinessProbe:
  httpGet:
    path: /api/cra/health
    port: 3011
  initialDelaySeconds: 10
  periodSeconds: 10
```

## What health does *not* tell you

Health confirms the service is up. It does **not** confirm that:

- your LLM tier (Ollama/DeepSeek/Anthropic) is reachable,
- your S3/MinIO audit target is writable,
- your custom rules file parsed correctly.

To confirm those end-to-end, submit a known diff and read the RFC back ([Your first analysis](first-analysis.md)). If Gate 3 silently does nothing, the LLM tier is likely misconfigured — see [LLM cost control](../how-to/llm-cost-control.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Connection refused | Container not started / wrong port | `docker compose ps`; check `PORT` and the published port |
| `200` but `status` not `ok` | Core failed to initialise | `docker compose logs meridian` for the startup error |
| Health ok, analyses never finish | LLM tier unreachable | Verify `OLLAMA_BASE_URL` / API keys; check egress in air-gapped setups |
| Health probe flapping in k8s | `start_period`/`initialDelaySeconds` too short on cold start | Increase the initial delay |

Next: [ENV reference](../configuration/env-reference.md)

