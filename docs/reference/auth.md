# Authentication & RBAC reference

Meridian supports three authentication models. They can coexist: the server tries each in order and uses the first that succeeds.

---

## Auth model summary

| Model | Header | When to use |
|---|---|---|
| API token | `Authorization: Bearer <token>` | CI/CD, scripts, MCP server, pre-commit hooks |
| OIDC JWT | `Authorization: Bearer <jwt>` | Human users, SSO, identity provider integration |
| Unauthenticated | — | `MERIDIAN_AUTH_ENABLED=false` (dev only) |

When `MERIDIAN_AUTH_ENABLED=false` (the default), all endpoints are open. **Never run in this mode in production.**

---

## API token auth

The simplest model. One or more opaque tokens are accepted from any caller that presents them.

### Configuration

```bash
# Single token (simplest)
CRA_API_TOKEN=<random-string-32-chars-min>

# Multiple tokens (rotate without downtime)
MERIDIAN_API_TOKENS=token-a,token-b,token-c

# Separate high-privilege override token
CRA_OVERRIDE_TOKEN=<separate-random-string>

# Enable auth enforcement
MERIDIAN_AUTH_ENABLED=true
```

`CRA_API_TOKEN` and `MERIDIAN_API_TOKENS` are equivalent — any token in either list is accepted.

`CRA_OVERRIDE_TOKEN` is required for override and approve endpoints and is checked separately (it is NOT accepted as a general API token).

### Request header

```
Authorization: Bearer <token>
```

Alternative (legacy support):

```
X-CRA-Token: <token>
```

### Generating tokens

```bash
# macOS / Linux
openssl rand -base64 32
```

---

## OIDC / JWT auth

For identity provider integration (Keycloak, Auth0, Azure AD, etc.).

### Configuration

```bash
MERIDIAN_OIDC_ISSUER=https://keycloak.example.com/realms/my-realm
MERIDIAN_OIDC_AUDIENCE=meridian   # must match the `aud` claim in the JWT
```

### JWT claim extraction

Meridian reads the following claims from the decoded JWT:

| JWT claim | Meridian field | Notes |
|---|---|---|
| `sub` | user ID | |
| `email` | user email | |
| `name` | display name | |
| `meridian_roles` | RBAC roles | Custom claim, array of role strings |
| `realm_access.roles` | RBAC roles | Keycloak-style nested claim |
| `meridian_tenant` | tenant ID | For multi-tenant setups |

If no role claim is present, the caller gets the `viewer` role.

---

## RBAC roles

Six roles form a strict hierarchy — each role includes all permissions of roles below it.

| Role | Level | Permissions |
|---|---|---|
| `viewer` | 1 | Read any RFC, finding, rule, or stat |
| `submitter` | 2 | + Submit diffs (`POST /api/cra/analyze`), create findings |
| `reviewer` | 3 | + Comment on findings, run LLM review |
| `cab-member` | 4 | + Approve or reject RFCs |
| `change-manager` | 5 | + Update configuration, manage rules |
| `admin` | 6 | Full access (all endpoints) |

### Route-level enforcement (examples)

| Endpoint | Minimum role |
|---|---|
| `GET /api/cra/health` | None (unauthenticated) |
| `GET /api/cra/rfc/*` | viewer |
| `POST /api/cra/analyze` | submitter |
| `POST /api/cra/rfc/*/override` | cab-member (or override token) |
| `PUT /api/cra/rules` | change-manager |
| `POST /api/cra/rfc/*/delete` | admin |

---

## Override token

Override actions (approving, overriding, bulk-overriding a BLOCKED RFC) require the `CRA_OVERRIDE_TOKEN` in addition to the standard API token.

This separation means:
- CI pipelines can analyze and read without override capability.
- Override capability is held only by callers that explicitly need it.

The MCP server's `cra.override` tool loads the override token from a separate Keychain entry (`cra-mcp-override`) so it does not need to be stored together with the read/write token.

```bash
# Present override token for approve/override endpoints
curl -X POST .../api/cra/approve/RFC-9F2C... \
  -H "Authorization: Bearer $CRA_OVERRIDE_TOKEN" \
  -d '{"reason":"FP — parameterized query confirmed"}'
```

---

## Endpoint auth matrix

| Endpoint | API token | Override token | Session (browser) | Unauthenticated |
|---|---|---|---|---|
| `GET /api/cra/health` | — | — | — | ✓ |
| `POST /api/cra/analyze` | ✓ | — | ✓ | dev only |
| `GET /api/cra/rfc/*` | ✓ | — | ✓ | dev only |
| `POST /api/cra/rfc/*/override` | — | ✓ | ✓ (admin) | — |
| `POST /api/cra/approve/*` | — | ✓ | ✓ (admin) | — |
| `POST /api/cra/bulk-override` | — | ✓ | ✓ (admin) | — |
| `GET /api/cra/rfcs` | ✓ | — | ✓ | dev only |
| `GET /api/cra/prod-check/*` | ✓ | — | ✓ | dev only |
| `POST /api/cra/webhook` | HMAC | — | — | — |
| `POST /api/cra/pending-tasks` | ✓ (token only) | — | — | — |
| `POST /api/cra/task-status` | ✓ (token only) | — | — | — |
| `POST /api/cra/usage/log` | ✓ (token only) | — | — | — |
| `PUT /api/cra/rules` | — | — | ✓ (admin) | — |

"Token only" means a session cookie is NOT accepted — only a machine bearer token.

---

## Webhook authentication

The `POST /api/cra/webhook` endpoint does not use bearer token auth. Instead it validates an **HMAC signature** against the raw request body.

### GitHub / Forgejo

The signature is in the `X-Hub-Signature-256` header:

```
X-Hub-Signature-256: sha256=<hmac>
```

Configure the webhook secret in your VCS and set it as `CRA_WEBHOOK_SECRET` on the Meridian instance:

```bash
CRA_WEBHOOK_SECRET=<same-string-as-vcs-webhook-secret>
```

### GitLab

The secret is in `X-Gitlab-Token`:

```
X-Gitlab-Token: <secret>
```

Set `MERIDIAN_GITLAB_SECRET` on the Meridian instance.

---

## Security recommendations

1. **Always enable auth in production.** `MERIDIAN_AUTH_ENABLED=false` is for local development only.
2. **Rotate tokens without downtime** using `MERIDIAN_API_TOKENS=old-token,new-token`, then remove the old one after all callers have updated.
3. **Separate the override token.** Do not share `CRA_OVERRIDE_TOKEN` with CI pipelines — only give it to callers (the MCP server, dashboard) that genuinely need override capability.
4. **Store tokens in a secrets manager,** not in plaintext files or environment variable exports in shell profiles. For the MCP server on macOS, use the Keychain.
5. **Use HTTPS.** Tokens travel in HTTP headers; without TLS they are trivially captured.

---

Next: [API endpoints](api-endpoints.md) · [MCP tools](mcp-api.md)
