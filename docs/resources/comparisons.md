# Comparisons: Meridian vs Semgrep vs GHAS vs SonarQube vs Snyk

This is a deep, honest comparison. The other tools are good at what they do — but they are built around a different assumption: *find and report*. Meridian is built around *find and block, then keep the record*.

## At a glance

| Capability | **Meridian** | Semgrep (Team) | GitHub Advanced Security | SonarQube | Snyk |
|---|---|---|---|---|---|
| Primary model | Blocking gate | Advisory SAST | Advisory (cloud) | Advisory quality/SAST | Advisory SCA/SAST |
| Blocks the deploy by default | **Yes** | No | No | No | No |
| Per-diff RFC artifact | **Yes** | No | No | No | No |
| WORM audit trail | **Yes** | No | No | No | No |
| LLM reasoning layer | **Yes** | No | No (Copilot is separate) | No | Partial (AI features) |
| Regex/pattern rules | Yes | Yes (strong) | Yes (CodeQL) | Yes | Yes |
| Structural/AST rules | Yes (Semgrep-compatible) | Yes (strong) | Yes (CodeQL, strong) | Yes | Yes |
| Self-hosted | **Yes** | Partial | No (cloud) | Yes | No |
| Air-gap capable | **Yes** | No | No | Partial | No |
| License | **Apache-2.0** | Proprietary (OSS engine exists) | Proprietary | LGPL / Commercial | Proprietary |
| Indicative price | **$0** | ~$450/mo | $19/seat/mo | $150+/mo | Quote-based |

> Prices are indicative public figures and change; verify with each vendor. The structural differences (block vs advise, RFC, WORM, air-gap) are the durable points.

## vs Semgrep

Semgrep's rule engine is excellent and Meridian's Gate 2 is Semgrep-compatible by design — you can bring Semgrep-style rules. The difference is the surrounding model:

- **Semgrep** reports findings; acting on them is up to your pipeline configuration. Meridian *is* the gate and refuses the change.
- Semgrep Team is a paid SaaS; Meridian is Apache-2.0 and self-hosted.
- Neither Semgrep tier produces an RFC or a WORM trail.

When to prefer Semgrep: you want the deepest, most mature rule library and are happy treating output as advisory. When to prefer Meridian: you want hard blocking + an auditable RFC + LLM review + air-gap.

## vs GitHub Advanced Security (CodeQL)

CodeQL is powerful and deeply integrated into GitHub — but:

- **Cloud-only.** GHAS cannot run air-gapped; your code is analysed in GitHub's environment. For regulated/offline shops this is a non-starter.
- **Per-seat pricing** ($19/seat/mo) scales with team size; Meridian is $0.
- Advisory by default; you build branch-protection around it (which Meridian also supports, but Meridian's *gate* is the product, not an add-on).
- No WORM RFC artifact.

When to prefer GHAS: you are all-in on GitHub cloud and want CodeQL's depth. When to prefer Meridian: you need self-hosting/air-gap, blocking-by-design, and a tamper-evident record.

## vs SonarQube

SonarQube is a code-quality and SAST platform with quality gates. Its "quality gate" can fail a build — closer to Meridian than the others — but:

- SonarQube's focus is broad code quality (smells, coverage, duplication) more than AI-specific risk.
- The paid tiers start around $150+/mo; Meridian is $0.
- No per-diff RFC + WORM trail with override-with-reason semantics.
- No tiered LLM reasoning layer.

When to prefer SonarQube: you want a comprehensive quality platform and coverage tracking. When to prefer Meridian: you want a focused, blocking change gate for (especially AI-generated) risk with an auditable decision record.

## vs Snyk

Snyk is strongest at software composition analysis (dependencies/vulnerabilities) and has SAST + AI features. Meridian does **not** do SCA — it reviews your *diff*, not your dependency tree. These are complementary:

- Use Snyk (or any SCA) for dependency/vuln management.
- Use Meridian as the blocking change gate with RFC + WORM for the code change itself.

## Honest summary

Meridian is **not** "better than" these tools across the board — they have larger rule libraries, more integrations, and years of polish. Meridian wins on a specific, unusual combination that none of them offer together:

1. **Blocks** (not advises) by design,
2. produces a **per-diff RFC**,
3. keeps a **WORM audit trail**,
4. adds an **LLM reasoning layer**,
5. is **self-hosted, air-gap capable, and Apache-2.0 ($0)**.

If you do not need blocking, an audit trail, or air-gap, one of the incumbents may serve you better. If you do — especially for AI-generated code in a regulated or cost-sensitive setting — that combination is the reason Meridian exists.

Next: [Further reading](further-reading.md)

