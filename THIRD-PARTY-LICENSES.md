# Meridian — Third-Party Licenses

**Stand:** 2026-05-29
**Scope:** Komponenten, die mit dem Meridian OSS-Core (Apache-2.0) ausgeliefert
oder zur Laufzeit benötigt werden. Quelle der Bewertung: `docs/meridian-license-audit.md`.

Diese Datei erfüllt die Attributionspflicht (Apache-2.0 §4) sowie die
Quelltext-Verweis-Pflicht für die im Stack verbleibenden (A)GPL/MPL-Dienste.
GPL/AGPL-Komponenten werden ausschließlich **unmodifiziert** und als **separate
Dienste** betrieben — der Verweis auf das öffentliche Upstream-Repo genügt damit.

---

## 1. npm-Laufzeitabhängigkeiten (im Image gebündelt)

| Paket | Lizenz | Verwendung | Source |
|---|---|---|---|
| better-sqlite3 | MIT | Embedded-DB (Change Records, Token-Registry) | https://github.com/WiseLibs/better-sqlite3 |
| nodemailer | MIT | E-Mail-Notifier (SMTP) | https://github.com/nodemailer/nodemailer |
| tree-sitter | MIT | AST-Parsing (Gate 2) | https://github.com/tree-sitter/tree-sitter |
| web-tree-sitter | MIT | AST WASM-Bindings | https://github.com/tree-sitter/tree-sitter |
| ts-morph + TypeScript | MIT / Apache-2.0 | TS-AST-Regeln | https://github.com/dsherret/ts-morph |

> Vollständige, generierte Liste aller transitiven npm-Lizenzen: per
> `npx license-checker --production --summary` zum Release erzeugen und hier anhängen.

---

## 2. Container / Dienste (separate Prozesse, nicht gelinkt)

| Komponente | Lizenz | SaaS-tauglich | Source |
|---|---|---|---|
| Node.js 20 | MIT | ✅ | https://github.com/nodejs/node |
| Debian bookworm (Base-Image) | diverse (DFSG-frei) | ✅ | https://www.debian.org/legal/licenses/ |
| tini | MIT | ✅ | https://github.com/krallin/tini |
| **SeaweedFS** | **Apache-2.0** | ✅ | https://github.com/seaweedfs/seaweedfs |
| ChromaDB | Apache-2.0 | ✅ | https://github.com/chroma-core/chroma |
| VictoriaLogs | Apache-2.0 | ✅ | https://github.com/VictoriaMetrics/VictoriaMetrics |
| Opengrep (Engine) | LGPL-2.1 | ✅ (CLI-Aufruf eigener Rules) | https://github.com/opengrep/opengrep |
| MkDocs Material | MIT | ✅ | https://github.com/squidfunk/mkdocs-material |
| LiteLLM | MIT | ✅ | https://github.com/BerriAI/litellm |
| CrowdSec | MIT | ✅ | https://github.com/crowdsecurity/crowdsec |
| BookStack | MIT | ✅ | https://github.com/BookStackApp/BookStack |

---

## 3. (A)GPL / MPL-Dienste — nur unmodifiziert, separat, mit Quell-Verweis

Diese Dienste sind **nicht** Bestandteil des Meridian-Codes und werden als
eigenständige Container betrieben. Pflicht: unmodifiziert halten + Quell-Link.

| Komponente | Lizenz | Policy | Source |
|---|---|---|---|
| Grafana | AGPL-3.0 | nur internes Ops-Dashboard, kein Kunden-Zugang | https://github.com/grafana/grafana |
| Forgejo | GPL-3.0+ | unmodifiziertes Image, nie in Core gelinkt | https://codeberg.org/forgejo/forgejo |
| Forgejo Runner | GPL-3.0+ | wie Forgejo | https://code.forgejo.org/forgejo/runner |
| MariaDB | GPL-2.0 | nur via SQL-Verbindung, separater Dienst | https://github.com/MariaDB/server |
| Vector | MPL-2.0 | unmodifiziert als Log-Agent | https://github.com/vectordotdev/vector |

---

## 4. Bewusst NICHT verwendet (Lizenz-Blocker — siehe Audit)

| Ersetzt | Lizenz-Problem | Ersatz |
|---|---|---|
| MinIO | AGPL-3.0 (SaaS-Lücke §13) | → SeaweedFS (Apache-2.0) — Blocker B-01 |
| PM2 | AGPL-3.0 | → Container-Restart + tini — Blocker B-02 |
| Semgrep Registry-Rules | Semgrep Rules License 1.0 (SaaS verboten) | → Opengrep + eigene Rules — Blocker B-03 |

---

## 5. Pflege

- Bei jeder neuen Abhängigkeit: Lizenz prüfen, Zeile ergänzen, AGPL/SSPL ablehnen.
- Vor jedem OSS-Release: `license-checker` laufen lassen, Diff gegen diese Datei.
- Diese Prüfung ist Teil des OSS-Publish-Gates (siehe ADR-0036).
