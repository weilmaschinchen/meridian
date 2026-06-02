# What is a change gate?

This page assumes you have never heard the term "change gate". By the end you will understand exactly what Meridian is and is not.

## The airport analogy

Think about how you get on a plane.

- A **metal detector** beeps when it sees something suspicious — but it does not physically stop you. Someone has to act on the beep. That is an **advisory scanner** (Semgrep OSS, SonarQube, most linters).
- A **boarding gate** is different. You cannot walk through it without a valid boarding pass. The gate is *closed* until a condition is met. That is a **change gate**.

Meridian is the boarding gate, not the metal detector. A change does not pass until its **RFC** (its boarding pass) is `APPROVED` or someone with authority `OVERRIDDEN` it on the record.

## Advisory vs blocking

| | Advisory scanner | Blocking gate (Meridian) |
|---|---|---|
| Finds problems | Yes | Yes |
| Stops the change | **No** | **Yes** |
| Requires a human to act | Yes, manually | Only to override; clean changes pass automatically |
| Leaves a verdict artifact | Usually a dashboard entry | A durable RFC |

The difference matters most at scale and at 2 a.m. An advisory tool produces a finding that someone *might* read. A gate produces a decision that *must* be resolved before anything ships.

## Why a gate, specifically for AI code?

AI assistants generate code faster than humans can review it. The failure modes are also different from human mistakes — assistants confidently produce plausible-looking code that:

- hardcodes a credential it "remembered" from training data,
- calls a shell with unsanitised input,
- silently drops a `WHERE tenant_id = ?` clause,
- uses `eval`/`pickle`/`yaml.load` on untrusted input.

A metal detector that beeps into an empty room does not help. A gate that refuses the change does.

## What a gate is *not*

- It is **not** a replacement for tests. Meridian checks the *shape and risk* of a diff, not whether your unit tests pass. Run both.
- It is **not** a firewall or WAF. It runs before deploy, on the diff, not on live traffic.
- It is **not** infallible. Gate 1 and 2 are pattern/structure based; Gate 3 is an LLM. Determined bad code can still slip through, and false positives happen — which is exactly why the [override flow](../how-to/block-and-override.md) exists and is recorded.

## How Meridian's gate decides

Three gates run in sequence (regex → AST → LLM). Any blocking finding produces a `BLOCKED` RFC. A clean run produces an `APPROVED` RFC. A human can change a `BLOCKED` RFC to `OVERRIDDEN` with a reason, and that act is written to the audit trail.

Next: [What is an RFC?](what-is-a-rfc.md)

