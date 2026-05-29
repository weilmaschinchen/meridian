# SPDX-License-Identifier: Apache-2.0
# Meridian — Unified IT Change Intelligence Platform
# Produktions-Image für den OSS-Core (Apache-2.0).
#
# Design-Entscheidungen (siehe docs/meridian-license-audit.md + ADR-0035):
#   • KEIN PM2  → Blocker B-02 gelöst. Container-Restart-Policy übernimmt
#     Prozess-Management (restart: unless-stopped in compose).
#   • Base = debian bookworm-slim (glibc), NICHT alpine (musl):
#     better-sqlite3 ist ein natives Modul. Auf glibc ziehen die offiziellen
#     Prebuilds; auf musl müsste node-gyp aus Source bauen (langsamer, fragil).
#   • Multi-Stage: Build-Toolchain bleibt im builder-Layer, das Runtime-Image
#     enthält keine Compiler → kleinere Angriffsfläche.
#   • Non-root (User node, UID 1000) im Runtime.
#
# Build:   docker build -f meridian/Dockerfile -t meridian/core:dev .
#          (Build-Context = Repo-Root, weil der Core aktuell noch unter
#           admin/ liegt. Nach der Extraktion (Phase 1) vereinfacht sich das.)

# ─────────────────────────────────────────────────────────────────────────
# Stage 1 — builder: native Module kompilieren / Prebuilds ziehen
# ─────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

# Toolchain nur falls better-sqlite3 keinen Prebuild für die Plattform hat
# (z. B. arm64 in manchen CI-Runnern). node-gyp braucht python3 + make + g++.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Erst nur die Manifeste kopieren → Layer-Cache bleibt stabil solange
# package.json / lock unverändert sind.
COPY package.json package-lock.json* ./

# npm ci = reproduzierbar aus dem Lockfile, nur Prod-Dependencies.
RUN npm ci --omit=dev \
    && npm cache clean --force

# ─────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime: schlankes Image ohne Compiler
# ─────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# tini = korrektes PID-1-Signal-Handling (SIGTERM → graceful shutdown),
# Ersatz für die Init-Funktion, die sonst PM2 übernommen hätte.
# wget für den HEALTHCHECK. Beide MIT-lizenziert / Debian-frei.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini \
      wget \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    MERIDIAN_BASE_PATH=/opt/meridian \
    DB_PATH=/data/meridian.db \
    PORT=3011

WORKDIR /opt/meridian

# Bereits aufgelöste node_modules aus dem builder übernehmen.
COPY --from=builder /build/node_modules ./node_modules

# Applikationscode. Aktuell liegt der Core unter admin/ + meridian/.
# (Nach Phase-1-Extraktion: COPY src/ ./src/ und CMD anpassen.)
COPY package.json meridian.config.json* ./
COPY admin ./admin
COPY meridian ./meridian

# Persistentes, beschreibbares Datenverzeichnis für die SQLite-DB.
# Muss dem Runtime-User gehören, sonst schlägt better-sqlite3 beim Öffnen fehl.
RUN mkdir -p /data && chown -R node:node /data /opt/meridian

USER node

EXPOSE 3011

# Container-natives Health-Signal. Pfad ist rückwärts-kompatibel
# (/api/cra/health == /api/v1/health laut Architektur-Spec §9).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/cra/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
# Dedizierter Meridian-Entrypoint (kein externes SSO / ADMIN_USER / Crons).
# Das private Ops-Dashboard bleibt davon unberuehrt.
CMD ["node", "meridian/server.js"]
