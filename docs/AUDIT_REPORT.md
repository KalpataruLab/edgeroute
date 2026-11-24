# Code Audit Report: proxy-load-balancer

**Scope:** all of `src/` (about 1,080 lines), `wrangler.toml`, `package.json`, `tsconfig.json`, repo hygiene.
**Perspective:** Tech Lead and SecOps Lead.
**Method:** static review only. No penetration test and no live-Worker testing. Findings are unverified against a running deployment.
**Date:** 2026-11-23

## Status legend

- **Open**: not addressed.
- **Done**: changed in the working tree (not yet committed unless noted).

## Critical and high

| # | Status | Area | Issue | Location | Recommended fix |
|---|---|---|---|---|---|
| 1 | Open | Auth | **HMAC fails open.** The check is `config.authSalt && route.hmacRequired`. If `authSalt` is missing or empty (bad KV write), every `hmacRequired` route is served with no auth and no warning. | `router.ts` (HMAC block) | Fail closed: if any route needs HMAC and no secret is set, return 500/503. Validate at config load. |
| 2 | Open | Audit trail | **Most audit fields never reach the logs.** `createLogEntry` copies only `matchedPrefix`, `targetUrl`, `timeout`, `error`. `auditType`, `reason`, `clientIp`, `hasToken` etc. are dropped at runtime. This is also the cause of the `tsc` errors. | `logger.ts`, `router.ts` | Widen `LogEntry`, spread extra fields, add a typecheck script. |
| 3 | Open | Admin | **`/admin/cache-flush` is open when `ADMIN_KEY` is empty** (`if (adminKey && ...)`), and `wrangler.toml` ships `ADMIN_KEY = ""`. Key comparison is not constant-time. | `index.ts` | Deny when no key is set, constant-time compare, set the key as a Wrangler secret. |
| 4 | Open | Info leak | **500/503 responses return `error.stack`, `error.message` and the internal target URL** to the caller. 504 also returns the target URL. | `router.ts` (catch blocks) | Return a generic body plus a request ID; log details server-side. |
| 5 | Done (design change) | Replay | **Nonce replay protection was a non-atomic KV get/put.** KV is eventually consistent, so cross-PoP or parallel replays inside the 30s window could pass. Per request decision, KV is no longer used for HMAC: the nonce check is now a per-isolate in-memory map. Replays across isolates or PoPs inside the window are **not** caught (accepted limit). | `auth.ts` | If strict one-time nonces are required later, use a Durable Object. |
| 6 | Open | Secrets | **HMAC secret (`authSalt`) and `turnstileSecretKey` are stored in KV in plaintext.** If the documented frontend-signing flow ships the key to the browser, anyone can extract it and the scheme is not authentication. | `config.ts`, `docs/prompts/PROMPT_FRONTEND_HMAC_SIGNING.md` | Move to Wrangler secrets; consider per-client keys or server-side signing only. |
| 7 | Open | Stale config | **Config cached 12 h per isolate.** Revoked keys or new block entries can take hours to apply; flush only clears one isolate, so it is not usable for incident response. | `config.ts`, `index.ts` | Short TTL (30-60 s) or a version key checked per request. |
| 8 | Open | HMAC body | **Body read with `.text()`**: binary bodies are mangled (hash mismatch/collisions); whole body buffered with no size cap (memory DoS). | `auth.ts` | Hash `arrayBuffer()`, enforce a size cap. |
| 9 | Open | Rate limit | **Per-isolate in-memory limiter.** Not a global limit, resets on cold start, bypassed by spreading across PoPs. If `CF-Connecting-IP` is absent the limit is skipped. Disabled in the sample config. | `ratelimit.ts`, `router.ts` | Use the Cloudflare Rate Limiting binding or WAF rules. |
| 10 | Open | Cost abuse | **Turnstile runs before rate limiting**, so each junk request costs a `siteverify` subrequest, which has no timeout. | `router.ts`, `turnstile.ts` | Rate limit first; add a timeout on `siteverify`. |

## Medium

- **`X-Forwarded-For` spoofable**: client value is kept and the real IP appended. Overwrite with `CF-Connecting-IP`.
- **All headers forwarded to the backend**, including `Cookie`, `Authorization`, `X-Auth-Token`, `X-Nonce`, `X-Turnstile-Token`, `CF-*`. Use an allowlist or strip proxy-only headers.
- **`blockedOrigins` uses substring `includes()`**: false positives and look-alike bypasses. Match on parsed hostname. Origin/Referer are spoofable by non-browsers, so this is a weak control.
- **CORS inconsistent**: preflight and error responses send `Access-Control-Allow-Origin: *` even when `allowedOrigins` is set; `Allow-Headers: *` and `Expose-Headers: *` are over-broad; `null` is returned as an origin value; `OPTIONS` skips blocklist, Turnstile and rate limit.
- **Percent-encoded `..` (`%2e%2e`)** is not normalized when joined onto the target; a decoding backend could be traversed above the route base path.
- **No config schema validation**: no `https:` check on targets, no duplicate-prefix check, no range checks on `rateLimitMultiplier` / `windowSeconds`. Sample config has `/api/data` and `/api/Data` (case-sensitive, so distinct routes).
- **Default-open routes**: `hmacRequired` defaults to `false`.
- **Full query strings logged** (`requestUrl`, `path`): tokens and PII end up in logs.
- **Log flooding**: a log line per non-HMAC request (`HMAC_BYPASSED`) and per success (`AUTH_SUCCESS`).
- **`REQUEST_TIMEOUT` not validated**: malformed value gives `NaN` and an immediate abort. Timeout is cleared after headers arrive, so body streaming is uncapped.
- **Backend redirect `Location` headers pass through**, exposing backend hostnames.

## Technical debt

- No tests, CI, lint or typecheck script. HMAC, routing and rate-limit logic is untested. `tsc` currently fails (see finding 2).
- `router.ts` is a 455-line function with log blocks and response builders copy-pasted about 8 times.
- Dead code: `verifyDynamicToken` (legacy, non-constant-time) is imported but unused; `getRateLimitStatus`, `clearRateLimitStore` unused; unused `ProxyConfig` import in `turnstile.ts`.
- Two lockfiles: `pnpm-lock.yaml` and `package-lock.json`. Pick one.
- `.gitignore` lists `wrangler.toml` but the file is tracked, so the ignore is ineffective and the KV namespace ID is committed.
- `compatibility_date = "2024-01-01"` is about 3 years old.
- Module-level mutable state (`configCache`, `rateLimitStore`, `seenNonces`) hinders testing and hides per-isolate behaviour.
- `catch (error: any)` throughout; use `unknown`.
- Docs sprawl (15+ markdown files incl. archive and prompts), likely to drift. `docs/hmac/*` probably still describes KV-backed nonces.

## Housekeeping

- A local, git-ignored `config.json` holds what appears to be a real `authSalt`. Correctly untracked; rotate if it was ever shared.
- Nothing sensitive was found tracked in git.

## Suggested remediation order

1. Findings 1-4: small diffs, largest security gain.
2. Finding 2 together with a typecheck script and a few HMAC and routing tests.
3. Findings 6 and 7: secrets and config TTL.
4. Findings 8-10: body hashing, rate limiting, Turnstile ordering.
5. Medium items and technical debt as capacity allows.

## Changes made during this audit

- Packages upgraded to latest; `moduleResolution` set to `bundler`; observability enabled (committed as `f7dad61`).
- HMAC nonce check moved from KV to in-memory (finding 5); **uncommitted**.

## Fix progress (uncommitted, see `docs/CLOUDFLARE_CHANGES.md` for the manual steps)

- **Done in code:** 1 (HMAC fails closed), 2 (audit fields logged, `tsc` clean), 3 (admin endpoint fails closed, constant-time compare), 4 (generic error bodies with `requestId`), 5 (KV removed from HMAC), 6 (secrets read from Wrangler secrets first), 7 (config cache 12 h to 60 s), 8 (raw-byte body hash, 1 MB cap), 10 (Turnstile after the rate-limit check, 5 s timeout).
- **Done (medium/debt):** `X-Forwarded-For` overwritten, blocklist by hostname, `REQUEST_TIMEOUT` validated, config validation (https targets, prefixes), query strings no longer logged, `HMAC_BYPASSED` log removed, dead `verifyDynamicToken` removed.
- **Needs a Cloudflare change, not code:** 9 (rate limiting rule at the edge), `workers.dev` URL, SSL mode, API token scope.
- **Done (second pass):** proxy-only and hop-by-hop headers stripped (a denylist, not an allowlist: a generic proxy cannot predict which headers backends need); one CORS function for preflight, responses and errors (no `*` with restricted origins, reflected preflight headers, blocklist on preflight); encoded `%2e`/`%2f`/`%5c` paths rejected; `hmacRequired` default kept at `false` but warned about at config load (set it explicitly per route in KV); `router.ts` split into `policy.ts`, `cors.ts` and a 260-line router; `catch` blocks use `unknown`; unused rate-limit exports removed; `compatibility_date` 2024-01-01 to 2026-11-01 (smoke-tested locally only); `wrangler.toml` removed from `.gitignore`; `package-lock.json` removed (the README uses pnpm, `pnpm-lock.yaml` refreshed); GitHub Actions CI (typecheck, auth check, wrangler dry-run); README and docs updated for the 60 s cache, secrets, generic errors and in-memory nonces.
- **Accepted / not changed:** module-level state (`configCache`, `rateLimitStore`, `seenNonces`) is per instance by design on Workers; the in-Worker rate limiter stays as a fallback and real limiting is the Cloudflare rule (item 9, see `docs/CLOUDFLARE_CHANGES.md`); strict cross-instance replay protection would need a Durable Object (declined: no KV, no new binding).
- **Still open:** none from the original list.
- **Check script:** `node scripts/check-auth.mts` (HMAC sign/verify, replay, tamper, wrong secret).
