# AST rules catalog (`arch-01` … `arch-16`)

Gate 2 ships sixteen built-in, Semgrep-compatible architectural rules. They check the *structure* of a diff — things a regex cannot reliably see. A rule at `ERROR` severity that matches makes the RFC `BLOCKED`.

!!! note "Reference, not source of truth"
    This catalog summarises the intent of each built-in rule. The authoritative definitions are the `.semgrep.yaml` files in `meridian/core/ast-spec/` in the [repo](https://github.com/weilmaschinchen/meridian). Exact patterns and supported languages may evolve between versions — check the source for specifics.

## The rules

| ID | Focus | What it flags (intent) |
|---|---|---|
| `arch-01` | Authentication | Route/handler defined without an authentication check on a path that should require one. |
| `arch-02` | Tenant scoping | Database query in a multi-tenant context missing the tenant filter (e.g. `WHERE tenant_id = ?`). |
| `arch-03` | Command execution | Shell/process execution (`exec`, `spawn`, `system`) with interpolated or untrusted input. |
| `arch-04` | Unsafe deserialization | `pickle`, `yaml.load` without SafeLoader, native deserialization of untrusted data. |
| `arch-05` | Dynamic code execution | `eval` / `Function` / dynamic `require`/`import` on request-derived data. |
| `arch-06` | SQL construction | SQL built by string concatenation/interpolation instead of parameterized queries. |
| `arch-07` | Secrets in code | Credentials/keys/tokens assigned as literals (structural complement to Gate 1 regex). |
| `arch-08` | TLS / cert verification | Disabling certificate verification (`rejectUnauthorized: false`, `verify=False`). |
| `arch-09` | Authorization checks | Sensitive operation lacking an authorization/role check. |
| `arch-10` | Input validation | Endpoint consuming request input without validation/sanitization. |
| `arch-11` | Path traversal | File access using unsanitized user-controlled path segments. |
| `arch-12` | SSRF | Outbound request to a URL derived from request input without allow-listing. |
| `arch-13` | Logging hygiene | Logging of secrets/PII (tokens, passwords, personal identifiers). |
| `arch-14` | Error handling | Swallowed errors / empty catch blocks that hide failures. |
| `arch-15` | Crypto misuse | Weak or misused cryptographic primitives (e.g. ECB mode, weak hashing for secrets). |
| `arch-16` | Dangerous defaults | Insecure defaults (permissive CORS `*`, debug enabled, open bind addresses). |

## How a rule reports

A matched rule appears in the RFC under `gates.ast.findings`:

```json
{
  "gates": {
    "ast": {
      "status": "fail",
      "findings": [
        {
          "id": "arch-02",
          "severity": "high",
          "message": "DB query missing tenant scope filter",
          "line": 42
        }
      ]
    }
  }
}
```

## Severity and blocking

- Rules authored at Semgrep `ERROR` map to blocking findings → RFC `BLOCKED`.
- Rules at `WARNING` are advisory and do not, by themselves, block.
- A genuine false positive should be handled via [override](../how-to/block-and-override.md), not by deleting the rule.

## Extending the catalog

To add `arch-17` and beyond, follow the [Custom AST rules](../external-patterns/custom-ast-rules.md) guide. Remember the current limitation: there is no runtime `MERIDIAN_AST_RULES_DIR`, so new AST rules require a build step or a plugin ([gaps](../external-patterns/gaps-and-roadmap.md)).

Next: [Comparisons](../resources/comparisons.md)

