<!-- SPDX-License-Identifier: Apache-2.0 -->
# Meridian — DevOps Gate

> The only **blocking** quality gate with a tamper-proof audit trail for
> AI- and low-code-generated change.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-beta-orange.svg)](#roadmap)

Meridian is the intelligence layer in front of your deploy. Every change is a
**Change Record** that runs through configurable quality gates, leaves a
manipulation-proof audit trail, and is *blocked* until it is approved — unlike
scanners (Semgrep/GHAS/SonarQube/Snyk) and process tools, which only *report*.

This repository is the **Open-Source DevOps Gate** (Apache-2.0). For the
ITIL-v4 change-management edition see [Editions](#editions).

---

## Why

AI assistants and low-code platforms ship code faster than humans can review it.
Meridian puts a **hard, technical gate** between "generated" and "in production":
no approved Change Record → no deploy. The decision is auditable, the trail is
WORM-stored, and the whole thing is self-hostable and air-gap-capable.

## Features

- **3-gate pipeline** — every change passes three stacked gates:
  1. **Risk Assessment** — pattern scan (risk / secret / vulnerability patterns)
  2. **AST Architecture Check** — architecture rules (Tree-Sitter / Semgrep-compatible)
  3. **LLM Review** — tiered router (local Ollama → DeepSeek → Anthropic)
- **Hard gate, not advisory** — blocks the deploy until an RFC is `APPROVED`.
- **RFC lifecycle** — `DRAFT → BLOCKED | APPROVED | OVERRIDDEN → SUPERSEDED`,
  every transition audited.
- **Tamper-proof audit** — reports to S3-compatible storage with Object-Lock (WORM).
- **Open adapter model** — Git forges (Forgejo / GitHub / GitLab), REST, webhooks.
- **Self-hosted & license-clean** — no PM2 (container-native restart + `tini`),
  SeaweedFS instead of MinIO, Opengrep instead of the Semgrep registry.
- **Pluggable** — optional plugins are loaded by name via `MERIDIAN_PLUGINS`; the
  core never hard-references them, so it stays self-contained.

## Quickstart

```bash
# 1. Configure
cp .env.example .env
$EDITOR .env            # set CRA_API_TOKEN, S3 keys, optional LLM keys

# 2. Run the full stack (core + SeaweedFS + AST-engine + Chroma)
docker compose up -d --build

# 3. Health
docker compose ps
curl -fsS http://localhost:3011/api/cra/health
```

Core only, against an external S3 endpoint:

```bash
docker build -f Dockerfile -t meridian/core:dev .
docker run -d --name meridian-core --restart unless-stopped \
  --env-file .env -p 127.0.0.1:3011:3011 meridian/core:dev
```

First-run database migration:

```bash
docker compose exec meridian node meridian/migrate.js up
```

## Configuration

All variables are documented in [`.env.example`](./.env.example). Most relevant:

| Group | Keys | Note |
|---|---|---|
| Core | `PORT`, `DB_PATH`, `MODULES_ENABLED` | `DB_PATH` is shared by runtime and `migrate.js` |
| Generalisation | `MERIDIAN_SERVER_HOST`, `MERIDIAN_APP_PATHS`, `MERIDIAN_BASE_PATH`, `MERIDIAN_RULES_PATH` | `MERIDIAN_RULES_PATH` points to your own rule file; otherwise `default-rules.json` applies |
| Rules / Plugins | `MERIDIAN_PLUGINS`, `MERIDIAN_PLUGINS_DIR` | comma-separated plugin names, resolved from the plugins dir |
| S3 / WORM | `CRA_MINIO_ENDPOINT`, `CRA_MINIO_PORT`, keys | points to SeaweedFS (S3-compatible) |
| LLM | `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `OLLAMA_BASE_URL`, `LLM_DAILY_CAP_USD` | tier routing local → DeepSeek → Anthropic |
| Auth | `MERIDIAN_AUTH_ENABLED`, `CRA_API_TOKEN` | `1` enforces token auth (`X-CRA-Token`) on `/api/cra/*` |

## Architecture

```
core/   — gate engine: RFC lifecycle, 3-gate pipeline, SQLite (better-sqlite3, WAL)
          + ast-spec/ (architecture rules: .scm + .semgrep.yaml + tests)
lib/    — llm.js (tiered LLM router / adapter) · plugins.js (optional plugin loader)
server.js  — raw-http entrypoint, mounts /api/cra/* (incl. /api/cra/health)
adapters/  — inbound git-forge webhooks
migrations/ + migrate.js — schema migrations
```

The core is self-contained: it loads optional plugins by name via `MERIDIAN_PLUGINS`
and never imports anything outside this tree. TLS terminates in a reverse proxy in
front of the container (the core listens on `127.0.0.1` only).

## Editions

Meridian follows an **Open-Core** model:

| | **Meridian DevOps Gate** (this repo) | **Meridian Enterprise (ITIL v4)** |
|---|---|---|
| License | Apache-2.0, open source | Commercial |
| Scope | 3-gate pipeline, RFC lifecycle, WORM audit, adapters | + ITIL v4 change management (Standard/Normal/Emergency, CAB, change-freeze windows, PIR) |
| Policy | built-in evaluator (score threshold, secrets, AST) | **OPA / Rego policy engine** — per-tenant policy bundles, four-eyes, blast-radius, cryptographic decision logs |
| Modules | devops-gate | + incident-mgmt, problem-mgmt, reporting (ISO/SOC/EU-AI-Act evidence), identity (OIDC/RBAC), CMDB sync, multi-tenancy |
| Hosting | self-hosted | self-hosted (private) or managed cloud |

The open core is the real engine — the gate logic, the RFC lifecycle, the rule
framework — and is meant to be run, modified and embedded freely. The commercial
edition adds the change-governance, compliance-evidence and multi-tenant layers that
regulated organisations and MSPs need. Both build from one trunk; the open core never
depends on the commercial modules.

> Interested in the Enterprise edition or managed hosting? Open an issue or get in touch.

## Roadmap

- **Now:** DevOps gate, RFC lifecycle, WORM audit, container stack.
- **Next:** standalone init CLI, OpenAPI spec, GitLab adapter, multi-user OIDC.
- **Enterprise:** ITIL-v4 change management, OPA/Rego policy engine, compliance reporting.

## License

Apache-2.0 — see [`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE) and
[`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md). Every source file carries an
SPDX header.

## Contributing

Issues and pull requests are welcome. Contributions are accepted under Apache-2.0
(inbound = outbound). Please keep new rule files in the documented `*-risk-patterns`
naming convention and add a test next to each architecture rule.
