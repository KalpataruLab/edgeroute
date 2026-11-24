# Edgeroute

*Config-driven edge routing on Cloudflare Workers.* By [KalpataruLab](https://github.com/KalpataruLab).

Edgeroute is a Cloudflare Worker (Hono) that routes requests to backend services by path prefix. Routes live in KV, so config changes need no redeploy.

## Features

- First-match-wins prefix routing, with query strings preserved and the prefix stripped.
- Several targets per route: weighted pick, failover for GET/HEAD, per-route circuit breaker ([LOAD_BALANCING](docs/LOAD_BALANCING.md)).
- Optional HMAC request signing with key rotation ([hmac/](docs/hmac/), [KEY_ROTATION](docs/KEY_ROTATION.md)).
- Per-IP rate limiting ([RATE_LIMITING_IMPLEMENTATION](docs/RATE_LIMITING_IMPLEMENTATION.md)) and optional edge caching of GET responses ([EDGE_CACHE](docs/EDGE_CACHE.md)).
- Config cached in memory and refreshed in the background (stale-while-revalidate), so no request waits on KV.
- Streaming request and response bodies, 120 s default timeout, generic 503/504/500 JSON errors with a `requestId`.
- Structured JSON logs and optional Analytics Engine metrics ([METRICS](docs/METRICS.md)).

## Quick start

```bash
pnpm install
pnpm run dev            # http://localhost:8787
pnpm test               # integration tests, config validation
```

Copy `config.example.json` to `config.json` (git-ignored), edit the routes, and upload it to KV. The full walk-through (KV namespace, secrets, deploy, rollback) is in [docs/OPERATIONS.md](docs/OPERATIONS.md); the config format is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Use domain names with `https://` for targets, not IP addresses. Routes are matched top to bottom, so put specific prefixes first.

## Documentation

| Page | Contents |
|---|---|
| [CONFIGURATION](docs/CONFIGURATION.md) | Route format, URL rewriting, environment variables, rate-limit settings, example configs |
| [OPERATIONS](docs/OPERATIONS.md) | Deploy, update config, rollback, admin endpoints, logs, errors, troubleshooting |
| [ENVIRONMENTS](docs/ENVIRONMENTS.md), [CONFIG_AS_CODE](docs/CONFIG_AS_CODE.md) | Staging/production and config in git |
| [ARCHITECTURE](docs/ARCHITECTURE.md), [SECURITY_DIAGRAM](docs/SECURITY_DIAGRAM.md) | How requests flow and where checks happen |
| [ROADMAP](docs/ROADMAP.md) | Open and finished work |

The full index is [docs/README.md](docs/README.md).

## Development

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm types              # regenerate worker-configuration.d.ts after editing wrangler.toml
```

### Git hooks

`pnpm install` points git at `.githooks/` (`core.hooksPath`). Before each commit the hook runs `scripts/check-forbidden.mts` (rejects forbidden identifiers in the lines being added, and an employer `user.email`) and then `pnpm typecheck`; the `commit-msg` hook checks the message. CI runs `pnpm check:forbidden` over every tracked file.

## License

MIT
