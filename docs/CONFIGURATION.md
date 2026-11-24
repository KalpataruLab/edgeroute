# Configuration

The route config is JSON stored in KV under the key `config`. Copy `config.example.json` to `config.json` (git-ignored) to start; to keep it in git see [CONFIG_AS_CODE](CONFIG_AS_CODE.md). Check a file with `pnpm validate-config`.

## Routes

```json
{
  "routes": [
    { "prefix": "/api/v2/users", "target": "https://users-v2.example.com" },
    { "prefix": "/api/v2", "target": "https://api-v2.example.com" },
    { "prefix": "/", "target": "https://default.example.com" }
  ],
  "version": "1.0"
}
```

- Routes are matched top to bottom; the first matching prefix wins. Put specific prefixes first.
- `target` must be `https://` and a domain name (Cloudflare needs a proper Host header; IPs get 403 or error 1003).
- `targets: [...]` gives several backends with weights and failover: [LOAD_BALANCING](LOAD_BALANCING.md).
- `healthCheck: { "path": "/healthz", "timeoutMs": 3000 }` (needs two or more `targets`) lets the cron probe each backend and skip dead ones: [LOAD_BALANCING](LOAD_BALANCING.md#active-health-checks).
- `cacheTtl` caches successful GETs at the edge: [EDGE_CACHE](EDGE_CACHE.md). Not allowed with `hmacRequired`.
- `hmacRequired` requires a signed request on that route: [hmac/SELECTIVE_HMAC_GUIDE](hmac/SELECTIVE_HMAC_GUIDE.md).
- `rateLimitMultiplier` scales the rate limit for that route (see below).

### Per-route options

All optional:

| Field | Meaning |
|---|---|
| `timeoutMs` | Backend timeout for this route, 1 to 600000 (default: `REQUEST_TIMEOUT`) |
| `methods` | Only these methods; others get 405 with `Allow` |
| `stripPrefix` | `false` keeps the prefix: `/api/users` with target `https://b.example.com/v2` goes to `/v2/api/users` (default `true`) |
| `headers` | Headers set on the backend request, replacing the client's. `Host`, `X-Forwarded-*`, `X-Request-Id` and framing headers are refused. Config is not a secret store: put secrets in Wrangler secrets |
| `websocket` | `true` passes WebSocket upgrades (GET with `Upgrade: websocket`) to the backend. Off by default: without it the `Upgrade` header is dropped. Browsers do not apply CORS to WebSockets, so a websocket route must have `allowedOrigins` (on the route or global) listing **full origins** such as `https://app.example.com`; the config is refused otherwise. A handshake whose `Origin` is not in the list exactly (scheme, host and port) gets 403, and the `Origin` is forwarded so the backend can check it too. Clients that send no `Origin` (non-browser) are allowed. Blocklist, rate limit and HMAC apply to the handshake; the connection afterwards is not inspected, and a socket is never retried on another target |
| `allowedOrigins` | Origin allowlist for this route, replacing the global one (CORS and preflight too) |

## URL rewriting

The matched prefix is removed and the rest of the path is appended to the target. Query strings are always kept.

| Request | Prefix | Target | Final URL |
|---|---|---|---|
| `/api/v1/orders?page=1` | `/api/v1` | `https://api.example.com/v1` | `https://api.example.com/v1/orders?page=1` |
| `/api/v1/users/123` | `/api/v1/users` | `https://users.example.com` | `https://users.example.com/123` |
| `/status` | `/` | `https://default.example.com` | `https://default.example.com/status` |

## Environment variables and secrets

Plain vars in `wrangler.toml`:

| Name | Default | Meaning |
|---|---|---|
| `REQUEST_TIMEOUT` | `120000` | Backend timeout in ms (504 after this) |
| `CACHE_TTL` | `60000` | Config cache freshness in ms; after it the config is refreshed in the background |
| `LOG_SUCCESS_SAMPLE` | `1` | Share (0 to 1) of successful request log lines to keep; errors are always logged |

Secrets, set per environment with `pnpm exec wrangler secret put <NAME> --env <env>`:

| Name | Meaning |
|---|---|
| `ADMIN_KEY` | Required for `/admin/cache-flush`; without it the endpoint returns 401 |
| `AUTH_SALT` | HMAC key (overrides `authSalt` in config) |
| `AUTH_KEYS` | JSON `{"key-id": "secret"}` for rotation: [KEY_ROTATION](KEY_ROTATION.md) |
| `BACKEND_SECRET` | Sent to every backend in `X-Proxy-Secret` so it can refuse traffic that skipped the proxy: [BACKEND_LOCKDOWN](BACKEND_LOCKDOWN.md) |
| `TURNSTILE_SECRET_KEY` | Turnstile secret (overrides the config value) |

Never put secrets in `config.json`; `pnpm validate-config` fails on `authSalt` or `turnstileSecretKey` in `config/*.json`.

## Origins

`allowedOrigins` and `blockedOrigins` are arrays of origins or hostnames. A `*.example.com` pattern matches all subdomains.

## Request limits

Optional, for every route, off by default:

```json
{ "limits": { "allowedMethods": ["GET", "POST"], "maxBodyBytes": 5242880 } }
```

- `allowedMethods`: other methods get 405 with an `Allow` header and never reach the backend.
- `maxBodyBytes`: a request whose `Content-Length` is larger gets 413. Only the declared length is checked; a chunked body has none, so this is not a hard cap on streamed uploads. HMAC routes keep their own 1 MB cap regardless.

## Signing options

Top-level, both optional and off by default:

```json
{ "deviceKeys": { "mode": "optional", "revoked": ["device-aaaa1111"] }, "strictReplay": true }
```

- `deviceKeys`: each device signs with its own key derived from the master secret; `required` drops the shared key. See [DEVICE_KEYS](hmac/DEVICE_KEYS.md).
  Add `"proof": "allowed"` or `"required"` for non-extractable device key pairs: [DEVICE_PROOF](hmac/DEVICE_PROOF.md).
- `strictReplay`: tokens work once across all instances, using a Durable Object. See [STRICT_REPLAY](hmac/STRICT_REPLAY.md).

## Rate limiting

```json
{
  "rateLimit": {
    "enabled": true,
    "requestsPerWindow": 100,
    "windowSeconds": 60,
    "hmacBypass": false,
    "hmacMultiplier": 10.0
  },
  "routes": [
    { "prefix": "/api/search", "target": "https://search.example.com", "hmacRequired": true, "rateLimitMultiplier": 0.2 }
  ]
}
```

- Limits are per client IP, fixed window, in memory (per isolate, reset on cold start).
- `hmacBypass: true` skips limits for HMAC-verified callers; `hmacMultiplier` raises their limit instead.
- `rateLimitMultiplier` is per route: 0.5 halves, 2.0 doubles.
- In the example, anonymous callers get 100 requests a minute, verified callers 1000, and `/api/search` 20 and 200.
- Over the limit: verified callers get 429 with `Retry-After`; anonymous callers get a silent 403. Events are logged as `RATE_LIMIT_EXCEEDED`.

More detail: [RATE_LIMITING_IMPLEMENTATION](RATE_LIMITING_IMPLEMENTATION.md).

## Examples

Microservices:

```json
{ "routes": [
  { "prefix": "/api/auth", "target": "https://auth.example.com" },
  { "prefix": "/api/users", "target": "https://users.example.com" },
  { "prefix": "/api", "target": "https://gateway.example.com" }
], "version": "1.0" }
```

Versioning (newest as the default):

```json
{ "routes": [
  { "prefix": "/v1", "target": "https://api-v1.example.com" },
  { "prefix": "/", "target": "https://api-v2.example.com" }
], "version": "1.0" }
```

Regional:

```json
{ "routes": [
  { "prefix": "/us", "target": "https://us-east.example.com" },
  { "prefix": "/eu", "target": "https://eu-west.example.com" }
], "version": "1.0" }
```
