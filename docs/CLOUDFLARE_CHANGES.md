# Cloudflare changes to apply

These are the manual steps in your Cloudflare account that go with the code fixes from `docs/AUDIT_REPORT.md`. The code changes alone are not enough: **do steps 1 and 2 before deploying**, or some routes will return 503.

Replace `example.com` and `<worker-name>` with your real values. Worker name is `proxy-load-balancer` (from `wrangler.toml`).

## 0. Order of work

1. Set the secrets (step 1).
2. Check the KV config (step 2).
3. Deploy the Worker (step 5).
4. Add the rate limiting rule (step 3) and review the dashboard settings (step 4).
5. Run the verification checks (step 6).

## 1. Set Worker secrets (required)

The code now reads secrets from Wrangler secrets first. The old `authSalt` / `turnstileSecretKey` fields in the KV config still work as a fallback, but they are stored in plaintext in KV and should be removed once the secrets exist.

```bash
npx wrangler secret put ADMIN_KEY             # protects POST /admin/cache-flush
npx wrangler secret put AUTH_SALT             # the HMAC signing key (same value your clients sign with)
npx wrangler secret put TURNSTILE_SECRET_KEY  # only if you use Turnstile
```

Notes:
- **`ADMIN_KEY` is now mandatory for the admin endpoint.** If it is not set, `/admin/cache-flush` always returns 401 (previously it was open when the value was empty). I removed the empty `ADMIN_KEY = ""` line from `wrangler.toml`. A plain variable and a secret with the same name conflict, so do not add it back as a variable.
- **`AUTH_SALT`:** use the existing value so current clients keep working, or generate a new one and roll it out to clients at the same time. Generate with `openssl rand -base64 48`. Rotate it if the old value was ever shared or shipped in a browser bundle.
- Secrets can also be set in the dashboard: Workers & Pages, your Worker, Settings, Variables and Secrets, type "Secret".

## 2. Update the KV config (required)

KV namespace `PROXY_CONFIG`, key `config` (binding ID is in `wrangler.toml`).

1. Read the current value:
   ```bash
   npx wrangler kv key get config --binding PROXY_CONFIG --remote > config.current.json
   ```
2. Edit it so that:
   - every `target` starts with `https://` (the Worker now **rejects the whole config** if any target is not https or any `prefix` does not start with `/`; it then keeps serving the last good config, or returns no routes if there never was one);
   - `authSalt` and `turnstileSecretKey` are **removed** (after step 1 is done);
   - `rateLimit.enabled` is `false` (see step 3);
   - there are no duplicate prefixes that differ only by case (for example `/api/data` and `/api/Data`) unless you really want two routes.
3. Write it back:
   ```bash
   npx wrangler kv key put config --binding PROXY_CONFIG --remote --path config.current.json
   ```
4. Keep `config.current.json` out of git (it is already ignored as `config.json`; use a name that is ignored or delete it afterwards).

**Behaviour change:** the Worker now caches the config for **60 seconds** (`CACHE_TTL = "60000"`), down from 12 hours. A KV edit takes effect within about a minute on each Worker instance. KV itself can take up to roughly a minute to propagate between locations, so allow about two minutes in total.

**Important:** any route with `"hmacRequired": true` now returns **503** if no HMAC secret is found (neither `AUTH_SALT` secret nor `authSalt` in KV). Before, it was served without authentication. This is intentional (fail closed).

## 3. Rate limiting: use Cloudflare's, not the in-Worker one

The in-Worker limiter is per instance and in memory, so it is not a real limit. Use a rate limiting rule at the edge, which runs before your Worker (and saves Worker requests).

Dashboard: select your zone, Security, WAF, Rate limiting rules, Create rule.

Example rule for the API paths:

| Field | Value |
|---|---|
| Rule name | `api-per-ip` |
| Expression | `(http.host eq "proxy.example.com" and starts_with(http.request.uri.path, "/api/"))` |
| Characteristics | IP |
| Requests | `100` |
| Period | `1 minute` (or `10 seconds` on plans that allow it) |
| Action | Block |
| Duration | `1 minute` (Free plans have fixed choices) |

Plan notes (check the dashboard; limits change):
- The Free plan includes a very small number of rules (the blog announcement listed one). One rule on the API paths is the best use of it.
- Advanced rate limiting (counting by header, API key, response codes, and so on) is an Enterprise add-on.
- The hostname must be **proxied (orange cloud)** through Cloudflare for zone rules to apply. A `*.workers.dev` URL is not covered by zone rules.
- Choose limits from real traffic in the logs first. Start in **Log** mode if your plan offers it, then switch to Block.

Optional later: the Workers Rate Limiting binding (`[[unsafe.bindings]]` / `ratelimits` in `wrangler.toml`) gives per-key limits from inside the Worker, but it is counted per Cloudflare location and needs a code change. Not needed to start.

## 4. Other dashboard settings to review

| Where | What to do |
|---|---|
| Workers, `<worker-name>`, Settings, Domains & Routes | Remove the public `*.workers.dev` URL if you only serve a custom domain, so traffic cannot bypass the zone's WAF and rate limiting rules. |
| Workers, Observability | Already enabled in `wrangler.toml` (`enabled = true`, logs and invocation logs on). Set a retention and sampling that matches your budget. |
| Security, WAF, Managed rules | Turn on the Free Managed Ruleset (free plans) or the plan's managed rules. |
| SSL/TLS | Mode **Full (strict)**. Turn on "Always Use HTTPS" and a minimum TLS version of 1.2. |
| Turnstile (if used) | Check the widget's allowed hostnames. The Worker only checks the token is valid, not which site issued it. |
| API tokens | Use a token scoped to this Worker and its KV namespace for deploys, not the global API key. Rotate any token that was ever pasted into a chat or a file. |
| Audit Logs (account) | Confirm who can edit the Worker, secrets and KV. |

## 5. Deploy

```bash
npx wrangler deploy --dry-run   # build check, already passes locally
npx wrangler deploy
```

`compatibility_date` is now `2026-11-01` (was `2024-01-01`). It was smoke-tested locally with `wrangler dev` (health, proxying, CORS preflight, blocklist, HMAC-misconfigured 503, encoded-path 400), but not against production. Deploy and run the step 6 checks; if anything misbehaves, set the date back and redeploy.

## 6. Verify after deploy

Replace the host with yours.

```bash
# Admin endpoint is closed without the key (expect 401)
curl -i -X POST https://proxy.example.com/admin/cache-flush

# ...and works with it (expect 200)
curl -i -X POST -H "X-Admin-Key: <your key>" https://proxy.example.com/admin/cache-flush

# HMAC route without a signature (expect 400, empty body)
curl -i https://proxy.example.com/api/data

# Errors no longer leak details: a 5xx body is only {"error": "...", "requestId": "..."}
```

Then in Workers, Observability, Logs, search for these `auditType` values. They did not appear before, because the logger dropped the extra fields (now fixed):

| `auditType` | Meaning |
|---|---|
| `HMAC_VERIFICATION_FAILED` | Signature, timestamp, nonce or body check failed. `reason` says which. |
| `HMAC_MISCONFIGURED` | A route needs HMAC but no secret is set (step 1 missed). |
| `AUTH_SUCCESS` | Request passed HMAC. It is the request's one log line (status, target, `deviceId`, `keyId`), not a separate line. |
| `BLOCKLIST_HIT`, `ORIGIN_BLOCKED`, `TURNSTILE_FAILED`, `RATE_LIMIT_EXCEEDED` | Other policy blocks. |

Set `LOG_SUCCESS_SAMPLE` (0 to 1, default 1 = log all) to keep only that share of lines for requests that ended below 400 (including `AUTH_SUCCESS` and `CACHE_HIT`). Failures and policy blocks are always logged, and metrics (docs/METRICS.md) count every request, so use metrics for totals. Setting it below 1 also thins the `AUTH_SUCCESS` audit trail.

Errors carry a `requestId` (the `cf-ray` when present). A client quoting it lets you find the log line with the full error and stack trace.

## 7. Behaviour changes to tell clients and ops about

- `/admin/cache-flush` needs `ADMIN_KEY`, and it only clears the cache of the Worker instance that handles the call. With a 60-second cache, waiting a minute is simpler.
- Replay protection for HMAC nonces is **per instance, in memory** (no KV). A captured request could be replayed inside the 30-second window if it lands on a different instance or location. A Durable Object is the fix if that risk is not acceptable.
- HMAC body hashing now uses the raw bytes (same result for normal text and JSON) and rejects signed bodies over **1 MB** with 413.
- `X-Forwarded-For` is now set to the real client IP only. Backends that read the first entry now get a value the client cannot spoof.
- The blocklist now matches the hostname exactly or as a subdomain, not as a substring.
- Query strings are no longer written to the logs (including the logged target URL).
- **CORS is decided in one place.** With `allowedOrigins` set, only allowed origins get `Access-Control-Allow-Origin`; others get none (and a 403 on real requests). Preflight reflects the requested headers instead of `*`, and applies the blocklist. Error responses use the same rules.
- **Encoded `%2e`, `%2f`, `%5c` and backslashes in the path are rejected with 400** (`auditType: PATH_REJECTED`).
- **Proxy-only headers are no longer sent to the backend:** `X-Auth-Token`, `X-Nonce`, `X-Timestamp`, `X-Body-Hash`, `X-Turnstile-Token`, `X-Admin-Key`, `X-Real-IP`, plus hop-by-hop headers. `Cookie` and `Authorization` are still forwarded. If a backend relied on one of the stripped headers, tell me.
- **Routes without an explicit `hmacRequired` still default to `false`** (changing it would open or close existing routes at deploy time). The Worker now logs a warning listing them: set `hmacRequired` explicitly on every route in the KV config.
- Error responses are generic JSON with a `requestId` instead of messages, stacks and backend URLs.

## 8. Rollback

- Code: `npx wrangler rollback` returns to the previous Worker version.
- Secrets: set again with `wrangler secret put`.
- KV config: keep the `config.current.json` you downloaded in step 2 and write it back with `kv key put`.
