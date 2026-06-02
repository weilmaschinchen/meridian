# Gaps and roadmap

This page is deliberately blunt. Knowing the limits up front saves you from discovering them in production.

## Known gaps (today)

### ~~No ~~ — **Resolved in v0.4.0**`MERIDIAN_AST_RULES_DIR`

The biggest rough edge. Regex rules load at runtime from `MERIDIAN_RULES_PATH`, but **custom Semgrep/AST rules do not have an equivalent runtime directory variable.** To add an `arch-xx` rule you must either:

- add the `.semgrep.yaml` to `meridian/core/ast-spec/` and rebuild the image, or
- carry it via a [plugin](plugin-authoring.md).

**Impact:** custom architectural rules cost you a build step and an image to maintain. If you can express your check as a regex, use [custom risk rules](custom-risk-rules.md) instead.

### Gate 1 is regex, not semantic

The risk gate is pattern matching. It catches what a regex can catch and misses what it cannot (data-flow across files, taint through helpers). Gate 2 (AST) and Gate 3 (LLM) exist precisely to cover some of that, but none of the three is a full taint-analysis engine.

### Gate 3 quality depends on the tier you run

Ollama-only is free and air-gap friendly but its review quality depends on the local model you pick. The cloud tiers (DeepSeek, Anthropic) reason better but cost money and require egress. There is no free lunch — pick the trade-off deliberately. See [LLM cost control](../how-to/llm-cost-control.md).

### Pre-receive enforcement is your hook, not built-in to your VCS

Meridian provides the verdict; **you** install the pre-receive hook or CI gate that enforces it. A team that forgets to wire enforcement has analysis without blocking. The integration guides ([Forgejo](../integrations/forgejo.md), [GitHub](../integrations/github.md)) show the wiring, but it is on you to make the check *required*.

### Diff-hash strictness can surprise you

An approval/override is bound to an exact diff hash. Rebasing or amending after approval invalidates it (new RFC). This is a feature (prevents bait-and-switch) but trips teams that push → rebase → push. Workflow: finish, rebase, push once.

### WORM is only as immutable as your bucket

Meridian writes audit records to S3-compatible storage (`CRA_MINIO_ENDPOINT`). True write-once-read-many depends on **object-lock retention configured on the bucket**. Meridian does not magically make a mutable bucket immutable.

## What Meridian deliberately is not

- Not a runtime WAF / IDS.
- Not a test runner.
- Not a dependency/SCA scanner (it reviews your diff, not your `node_modules`). Pair it with an SCA tool if you need that.
- Not a managed SaaS — you host it (which is the point for air-gap).

## Roadmap themes (non-binding)

!!! note
    These are directions, not promises or dates. Check the [GitHub repo](https://github.com/weilmaschinchen/meridian) for the authoritative status.

- **Runtime AST rule loading** — a `MERIDIAN_AST_RULES_DIR` analogue to close the biggest gap.
- **Richer plugin context** — a documented, stable hook surface for `init(ctx)`.
- **First-class CI actions** — packaged GitHub Action / Forgejo workflow instead of hand-rolled scripts.

## How to influence it

Open an issue or PR on [github.com/weilmaschinchen/meridian](https://github.com/weilmaschinchen/meridian). Concrete use-cases ("I needed X because Y") move the roadmap more than feature wishlists.

