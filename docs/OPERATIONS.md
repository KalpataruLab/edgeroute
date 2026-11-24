# Operations

Replace `<worker-url>` with your Worker's URL and `<kv-id>` with its KV namespace ID. For staging and production see [ENVIRONMENTS](ENVIRONMENTS.md); always deploy with `--env`.

## First deploy

```bash
pnpm exec wrangler kv namespace create PROXY_CONFIG      # copy the id into wrangler.toml
pnpm exec wrangler secret put ADMIN_KEY --env production
pnpm exec wrangler secret put AUTH_SALT --env production
pnpm exec wrangler kv key put --namespace-id=<kv-id> config --path=config.json --remote
pnpm run deploy:production
curl <worker-url>/health
```

## Update config

```bash
pnpm validate-config config.json
pnpm exec wrangler kv key put --namespace-id=<kv-id> config --path=config.json --remote
curl -X POST <worker-url>/admin/cache-flush -H "X-Admin-Key: $ADMIN_KEY"   # optional: reload now
```

Without the flush, instances pick up the change within `CACHE_TTL` (60 s by default), refreshed in the background. Other KV commands: `kv key get`, `kv key list`, `kv key delete` with the same `--namespace-id`. To keep config in git and push it from CI, see [CONFIG_AS_CODE](CONFIG_AS_CODE.md).

## Rollback

```bash
pnpm exec wrangler deployments list
pnpm exec wrangler rollback [version-id]
```

For a bad config, put the previous `config.json` back in KV and flush the cache.

## Admin endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | `{"status":"ok","timestamp":"..."}` |
| `POST /admin/cache-flush` | Drop the cached config and reload from KV. Needs the `X-Admin-Key` header; 401 if missing, wrong, or `ADMIN_KEY` unset |

### Versioned config API

An alternative to `wrangler kv key put`: every save is validated first, kept as a numbered revision (the last 20), and can be rolled back. It uses the existing KV namespace, so there is no new binding. All calls need `X-Admin-Key` (401 if missing, wrong, or `ADMIN_KEY` unset).

| Call | What it does |
|---|---|
| `GET /admin/config` | `{ rev, config }`: the live config and its revision |
| `PUT /admin/config` | Body is the config JSON. Validated like `pnpm validate-config`: 400 with the reason if invalid, nothing changes. 413 over 256 KB. Optional `If-Match: <rev>` gives 412 if someone saved in between. Returns `{ rev, warnings }` |
| `GET /admin/config/history` | `{ rev, history: [{ rev, at }] }`, newest first |
| `POST /admin/config/rollback` | Body `{ "rev": 3 }`. Re-validates that revision and saves it as a new revision (history is never rewritten) |

```bash
curl -X PUT <worker-url>/admin/config -H "X-Admin-Key: $ADMIN_KEY" -H "If-Match: 4" --data-binary @config.json
curl -X POST <worker-url>/admin/config/rollback -H "X-Admin-Key: $ADMIN_KEY" -d '{"rev":3}'
```

Notes: the instance that handled the call reloads at once; others pick it up within `CACHE_TTL`. KV is not transactional, so use one writer at a time (`If-Match` catches most clashes). Writes are logged with `auditType: ADMIN_CONFIG` (rev and action, never the config). If you also deploy config from CI ([CONFIG_AS_CODE](CONFIG_AS_CODE.md)), CI writes straight to KV and bypasses the revision history.

**Cloudflare Access (recommended on top of the key).** In Zero Trust, add a self-hosted application for `<your-host>/admin/*` with a policy for your admins. Requests are then blocked at Cloudflare's edge before they reach the Worker, and the `X-Admin-Key` check stays as a second layer. Automation can use an Access service token plus the key. This is a dashboard step; nothing in the Worker depends on it.

## Responses and errors

| Code | Meaning |
|---|---|
| 404 | No route matches the path |
| 403 | HMAC check failed, blocked origin, or rate limit for an anonymous caller |
| 405 | Method not in `limits.allowedMethods` |
| 413 | Body over the 1 MB limit on a signed route, or declared larger than `limits.maxBodyBytes` |
| 429 | Rate limit for a verified caller (`Retry-After` set) |
| 500 | Worker error |
| 503 | Backend unreachable or failing (after failover) |
| 504 | Backend did not answer within `REQUEST_TIMEOUT` |

Errors are generic: `{"error": "Gateway Timeout", "requestId": "8a1f..."}`. Details and stack traces are in the logs under the same `requestId`, never in the response.

## Request IDs

Every request has an ID. A caller's `X-Request-Id` is used if it is 1 to 64 characters of letters, digits, `.`, `_` or `-`; otherwise the Worker uses `cf-ray` or generates a UUID. The ID is forwarded to the backend as `X-Request-Id`, returned in the response header (it replaces any value the backend sent) and in error bodies, and appears as `requestId` in every log line, so one request can be followed from client to backend.

## Logs and metrics

```bash
pnpm run tail          # live logs (add --env <env>)
```

Each request logs one JSON line: `timestamp`, `method`, `requestUrl`, `path`, `matchedPrefix`, `targetUrl`, `status`, `responseTime`, plus `timeout`, `error`, `requestId`, and auth fields (`auditType`, `hmacVerified`, `deviceId`, `keyId`) when relevant. Successful lines can be sampled with `LOG_SUCCESS_SAMPLE`; status 400 and above is always logged. Field changes are listed in [CLOUDFLARE_CHANGES](CLOUDFLARE_CHANGES.md). Metrics and alerting: [METRICS](METRICS.md).

## Troubleshooting

**403 from a backend.** The target is an IP or the backend blocks Cloudflare. Use a domain name with `https://`; for error 1003 the backend is behind Cloudflare and must be addressed by hostname. If the backend filters by IP, allow the [Cloudflare ranges](https://www.cloudflare.com/ips-v4).

**Config change not visible.** Check KV has the new value (`kv key get ... --remote`), flush the cache, and if needed redeploy. Config that fails validation is ignored and the last good copy keeps serving; look for `Error loading config` in the logs.

**Route not matching.** Routes are first-match-wins; check the order and watch `pnpm run tail` for `matchedPrefix`.
