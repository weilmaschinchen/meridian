# Plugin authoring

**Prerequisites**

- A running Meridian instance ([Docker Compose](../getting-started/docker-compose.md))
- Node.js basics
- A directory you can mount into the container for `MERIDIAN_PLUGINS_DIR`

**What you'll have after**

A working plugin loaded by Meridian that exposes a custom route — written in about 20 lines.

## The contract

A Meridian plugin is a Node.js module that exports two functions:

| Function | When it runs | Purpose |
|---|---|---|
| `init(ctx)` | Once at startup | Set up state, register hooks, read config. Receives a context object. |
| `handleRoute(req, res)` | Per matching HTTP request | Serve a custom endpoint or side-effect. |

Plugins are loaded by **name** from `MERIDIAN_PLUGINS` (comma-separated) and **resolved** from `MERIDIAN_PLUGINS_DIR`.

## A minimal plugin (≈20 lines)

`/plugins/audit-ping.js`:

```javascript
// audit-ping: a minimal Meridian plugin
let startedAt;

module.exports = {
  // Called once when Meridian boots.
  init(ctx) {
    startedAt = new Date().toISOString();
    ctx?.log?.('audit-ping plugin initialised');
  },

  // Called for requests routed to this plugin.
  handleRoute(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      plugin: 'audit-ping',
      startedAt,
      now: new Date().toISOString(),
    }));
  },
};
```

## Load it

```yaml
services:
  meridian:
    volumes:
      - ./plugins:/plugins:ro
    environment:
      - MERIDIAN_PLUGINS_DIR=/plugins
      - MERIDIAN_PLUGINS=audit-ping
```

```bash
docker compose up -d
```

Confirm it loaded in the logs:

```bash
docker compose logs meridian | grep audit-ping
# audit-ping plugin initialised
```

## A more useful pattern: notify on a blocked RFC

Plugins are the right place for side-effects that are not detection logic — e.g. mirror blocked RFCs to a chat or ticket system. Do the work in `init()` by subscribing to whatever hook your `ctx` exposes, and/or expose a `handleRoute()` your own automation can call.

```javascript
module.exports = {
  init(ctx) {
    // Pseudo-hook: adapt to the context your build exposes.
    ctx?.on?.('rfc:blocked', async (rfc) => {
      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Meridian blocked ${rfc.rfc_id} on ${rfc.repo_name}/${rfc.branch}`,
        }),
      });
    });
  },
  handleRoute(_req, res) {
    res.end('audit-notify ok');
  },
};
```

!!! note
    The exact shape of the `ctx` object and available hooks depends on your Meridian version. Inspect what `init(ctx)` receives (log it) and code against that. Keep plugins defensive (`ctx?.on?.(...)`) so a missing hook does not crash boot.

## Guidance

- Keep plugins **single-purpose**. One integration per plugin is easier to reason about and disable.
- Plugins run **in-process** — a throwing `init()` can take the service down. Wrap risky work in try/catch.
- Do not put detection regexes in a plugin if a [rules file](custom-risk-rules.md) will do — that path needs no code.
- Pin any external deps and vendor them into `MERIDIAN_PLUGINS_DIR` for air-gapped deployments.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Plugin not loaded | Name/dir mismatch | `MERIDIAN_PLUGINS` name must match the file/module resolvable in `MERIDIAN_PLUGINS_DIR` |
| Service won't boot after adding plugin | `init()` threw | Wrap in try/catch; check `docker compose logs` |
| Route 404 | Route not wired | Confirm the build maps plugin routes; check the version's plugin docs/log output |
| Works locally, fails in air-gap | External `fetch`/deps unreachable | Vendor deps; gate network side-effects behind config |

Next: [Gaps and roadmap](gaps-and-roadmap.md)

