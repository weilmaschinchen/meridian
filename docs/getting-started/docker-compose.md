# Getting started: Docker Compose

**Prerequisites**

- Docker Engine 24+ and the Docker Compose plugin (`docker compose version` works)
- Git
- ~2 GB free disk, an open local port `3011`
- (Optional) An Ollama, DeepSeek, or Anthropic endpoint for Gate 3. Without one, Gates 1 and 2 still run.

**What you'll have after**

A running Meridian instance on `http://localhost:3011`, with a healthy `/api/cra/health` endpoint, ready to analyse its first diff.

## Steps

### 1. Clone and start

```bash
git clone https://github.com/weilmaschinchen/meridian.git
cd meridian
docker compose up -d --build
```

Expected output (abridged):

```text
[+] Building 48.2s (16/16) FINISHED
[+] Running 2/2
 ✔ Network meridian_default      Created
 ✔ Container meridian-meridian-1  Started
```

### 2. Confirm the container is up

```bash
docker compose ps
```

Expected:

```text
NAME                  IMAGE      STATUS         PORTS
meridian-meridian-1   meridian   Up 10 seconds  0.0.0.0:3011->3011/tcp
```

### 3. Health check

```bash
curl -s http://localhost:3011/api/cra/health
```

Expected:

```json
{"status":"ok"}
```

A fuller walkthrough of what health tells you is in [Health check](health-check.md).

### 4. (Optional) set environment variables

Meridian reads configuration from the environment. The simplest way is a `.env` file next to `docker-compose.yml`:

```bash
# .env
PORT=3011
DB_PATH=/data/meridian.db
# Gate 3 — pick the tiers you want. Leave all unset for Gates 1+2 only.
OLLAMA_BASE_URL=http://host.docker.internal:11434
LLM_DAILY_CAP_USD=2.00
# Auth (recommended once you expose it beyond localhost)
MERIDIAN_AUTH_ENABLED=true
CRA_API_TOKEN=replace-with-a-long-random-token
```

Apply changes:

```bash
docker compose up -d
```

The full list is in the [ENV reference](../configuration/env-reference.md).

### 5. Persist data

The RFC database lives at `DB_PATH` inside the container. Make sure your `docker-compose.yml` maps a volume so RFCs survive restarts, e.g.:

```yaml
services:
  meridian:
    volumes:
      - meridian-data:/data
volumes:
  meridian-data:
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `curl` connection refused | Container still building or crashed | `docker compose logs -f meridian` and look for the listen line |
| Port 3011 already in use | Another service bound it | Set `PORT=3012` in `.env` and the compose port mapping, then `docker compose up -d` |
| `health` returns ok but Gate 3 never runs | No LLM tier configured | Set `OLLAMA_BASE_URL` (free) or an API key; see [LLM cost control](../how-to/llm-cost-control.md) |
| RFCs disappear after restart | No volume for `DB_PATH` | Add the volume mapping shown in step 5 |
| `host.docker.internal` unresolved (Linux) | Linux Docker doesn't add it by default | Use the host IP, or add `extra_hosts: ["host.docker.internal:host-gateway"]` |

Next: [Submit your first analysis](first-analysis.md)

