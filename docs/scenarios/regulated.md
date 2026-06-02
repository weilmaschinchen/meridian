# Scenario: regulated industry (fintech / healthcare)

## Who this is for

Teams under regulatory or contractual obligations — fintech (PCI-DSS, DORA), healthcare (HIPAA), or any environment where an auditor will eventually ask: *"prove that this change was reviewed, show me the verdict, and show me who accepted any risk and why."*

## The requirement

Advisory scanners cannot answer that question. A dashboard finding is not evidence that a control was *enforced*. You need:

1. A control that **blocks** non-compliant changes (not warns).
2. A **tamper-evident record** of every change decision.
3. The ability to run **on-prem / air-gapped** so code and secrets never leave your boundary.

Meridian is built for exactly this triad.

## How Meridian maps to controls

| Auditor question | Meridian answer |
|---|---|
| Was the change reviewed before deploy? | Every diff has an RFC produced by the 3-gate pipeline. |
| Was the control enforcing or advisory? | The pre-receive/CI gate **blocks** `BLOCKED` RFCs from shipping. |
| Who accepted residual risk, and why? | The `OVERRIDDEN` state records actor + reason on the WORM trail. |
| Can the record be altered after the fact? | Audit records are written to object-lock S3 storage (WORM). |
| Did code leave our boundary? | Air-gap mode (Ollama-only, no API keys) makes no outbound calls. |

## The setup

```bash
# .env
MERIDIAN_AUTH_ENABLED=true
CRA_API_TOKEN=<long-random-token>

# Air-gapped LLM review: local only, no egress, no spend
OLLAMA_BASE_URL=http://ollama:11434
# (intentionally no DEEPSEEK_API_KEY / ANTHROPIC_API_KEY)

# WORM audit trail to object-lock storage
CRA_MINIO_ENDPOINT=http://minio:9000
```

### Making the audit trail truly WORM

Meridian writes audit records; the **immutability is enforced by the bucket**. Configure your S3/MinIO bucket with **object-lock retention** (compliance mode) so records cannot be deleted or modified within the retention window — even by an admin. Without object-lock, you have an audit *log*, not a WORM *trail*. This is called out in [Gaps and roadmap](../external-patterns/gaps-and-roadmap.md); do not skip it.

### Enforce, do not advise

Install the server-side [pre-receive gate](../integrations/forgejo.md) (or a required [CI check](../integrations/github.md)) and make it mandatory. An enforcing control is the difference between "we have a tool" and "we have a control".

## Override discipline

In a regulated context the override reason is evidence. Require structured reasons that reference a ticket and a remediation date:

```bash
curl -s -X POST http://meridian:3011/api/cra/rfc/<id>/override \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{
    "actor": "security-lead@bank.example",
    "reason": "Accepted risk per CHG-4821; compensating control: WAF rule WR-22; remediation due 2026-06-30."
  }'
```

Limit who holds override authority and review the override log on a schedule.

## What you get

- An **enforcing** change control with a defensible, tamper-evident record per change.
- **No data egress** in air-gap mode — something cloud SAST (e.g. GHAS) cannot offer.
- $0 licensing (Apache-2.0), which simplifies procurement and vendor risk assessment.

## Honest caveats

- Meridian is a change-time control, not a runtime control, and not a substitute for your SCA/pen-test program. Layer it.
- WORM guarantees are only as strong as your bucket's object-lock configuration.
- Gate 1 is regex and Gate 3 quality depends on your local model; treat the gate as one defence-in-depth layer, not the only one.
- You own operating and hardening the deployment (it is self-hosted by design).

Next: [API endpoints](../reference/api-endpoints.md)

