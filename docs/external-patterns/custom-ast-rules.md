# Custom AST rules

**Prerequisites**

- Familiarity with [Semgrep rule syntax](https://semgrep.dev/docs/writing-rules/rule-syntax)
- The Meridian source tree (you will be building a custom image — see the limitation below)
- The [built-in AST catalog](../reference/ast-rules-catalog.md) as a reference for the house style

**What you'll have after**

A new structural rule running in Gate 2, in the same `arch-xx` style as the built-ins.

!!! warning "The honest limitation"
    There is **no `MERIDIAN_AST_RULES_DIR`** environment variable today. Unlike regex rules (which load from `MERIDIAN_RULES_PATH` at runtime), custom AST rules cannot be dropped in from outside. You have two options:

    1. **Build-time:** add your `.semgrep.yaml` to `meridian/core/ast-spec/` and build a custom image.
    2. **Plugin:** carry/register the rule via a [plugin](plugin-authoring.md).

    This is the roughest edge in Meridian's extensibility story. It is tracked in [Gaps and roadmap](gaps-and-roadmap.md). If you only need pattern matching, prefer [custom risk rules](custom-risk-rules.md) — they need no rebuild.

## The `arch-xx` format

Gate 2 rules are Semgrep-compatible YAML. The built-ins are `arch-01` through `arch-16`. Follow the same shape:

```yaml
rules:
  - id: arch-17-missing-rate-limit
    languages: [javascript, typescript]
    severity: ERROR
    message: >
      Route handler defined without a rate-limit middleware. Unbounded
      endpoints are a DoS and abuse risk.
    metadata:
      category: security
      meridian-gate: ast
    patterns:
      - pattern: app.$METHOD($PATH, $HANDLER)
      - metavariable-regex:
          metavariable: $METHOD
          regex: ^(get|post|put|delete|patch)$
      - pattern-not-inside: |
          app.use(rateLimit(...))
          ...
```

Conventions that match the built-ins:

- **`id`** must be `arch-<NN>-<slug>`; keep numbering contiguous after `arch-16`.
- **`severity: ERROR`** for a blocking rule (Gate 2 fail → RFC `BLOCKED`). Use `WARNING` for advisory-only.
- **`message`** explains the risk *and* the fix.
- **`metadata.meridian-gate: ast`** marks it as a Gate-2 rule.
- One concern per rule; small and testable.

## Step 1 — Add the rule (build-time path)

Place the file in the AST spec directory of your checkout:

```bash
cp arch-17-missing-rate-limit.semgrep.yaml meridian/core/ast-spec/
```

## Step 2 — Validate it in isolation

Use Semgrep locally against a fixture before rebuilding Meridian:

```bash
cat > /tmp/bad.js <<'EOF'
app.get('/users', (req, res) => res.json(db.all()));
EOF

semgrep --config meridian/core/ast-spec/arch-17-missing-rate-limit.semgrep.yaml /tmp/bad.js
```

Expected (abridged):

```text
  arch-17-missing-rate-limit
    Route handler defined without a rate-limit middleware. ...
     1| app.get('/users', (req, res) => res.json(db.all()));
1 finding.
```

## Step 3 — Rebuild and run

```bash
docker compose up -d --build
```

## Step 4 — End-to-end check

```bash
curl -s -X POST http://localhost:3011/api/cra/analyze \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CRA_API_TOKEN" \
  -d '{"repo_name":"t","branch":"x","commit_message":"t","diff":"+++ b/r.js\n+app.get(\"/users\", (req,res)=>res.json(db.all()));\n"}' \
  | jq '.gates.ast.findings[].id'
```

Expected to include:

```json
"arch-17-missing-rate-limit"
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Rule not applied after editing | No rebuild | Custom AST rules are build-time; `docker compose up -d --build` |
| Semgrep parse error | Invalid YAML / pattern | `semgrep --validate --config <file>` |
| Rule matches too much | Pattern too generic | Add `pattern-not`, `pattern-inside`, `metavariable-regex` constraints |
| Wrong language | `languages` missing your lang | Add the language(s) the rule applies to |
| Want runtime loading | No `MERIDIAN_AST_RULES_DIR` | Use a plugin, or upvote the roadmap item |

Next: [Plugin authoring](plugin-authoring.md)

