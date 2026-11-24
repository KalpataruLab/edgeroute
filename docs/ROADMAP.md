# Roadmap

Planned improvements for the proxy load balancer, from the code audit and the v2.2.0 review. Items marked **Done** are implemented. Items are ordered by value within each section; priorities are suggestions, not commitments.

Related: `docs/AUDIT_REPORT.md` (findings), `docs/CLOUDFLARE_CHANGES.md` (manual Cloudflare steps), `docs/FUTURE_PLANS.md` (Turnstile rollout).

## Suggested order

1. ~~Integration tests~~ (done)
2. ~~Staging and production environments~~ (done)
3. ~~Config as code with validation~~ (done)
4. ~~Load balancing with failover and retries~~ (done)
5. ~~Metrics, alerts and HMAC key rotation~~ (done)

Tests, environments and config validation come first because they make every later change safer to ship.

## Priority 1: highest value

| # | Item | Why | Rough size |
|---|---|---|---|

## Performance

- **Remove the in-Worker rate limiter** once the Cloudflare edge rule is live. It is per instance, so it adds code and CPU without a real limit. Waiting on you: the edge rule must be live first (docs/CLOUDFLARE_CHANGES.md). Until then it is already off unless the config sets `rateLimit.enabled`, so nothing needs to change in code to stop using it; deleting `src/ratelimit.ts` is a small follow-up once the rule is confirmed.

## Features

None open. Everything planned here is in Done.

## Quality and developer experience

None open.

## Done

- Device-aware HMAC, phase 2 (proof of possession): `deviceKeys.proof` (`allowed` or `required`). The device keeps a non-extractable ECDSA P-256 key; the backend binds its public key to the device ID with an HMAC enrollment token; the Worker verifies that token and the ECDSA signature, statelessly. Server side and docs only: the client change is described in `docs/hmac/DEVICE_PROOF.md` and needs to be built and tried by the client team.
- Strict replay protection (opt-in): `"strictReplay": true` claims each verified token in a sharded `ReplayGuard` Durable Object (SQLite-backed, new `REPLAY` binding approved by the user), so a token works once across all instances. Fails closed if the object is unreachable. The binding and migration are created at the next deploy; off until configured. See `docs/hmac/STRICT_REPLAY.md`.
- Admin API for config: `GET/PUT /admin/config`, `GET /admin/config/history`, `POST /admin/config/rollback` with validation before save, `If-Match` conflict check and the last 20 revisions, in the existing KV namespace (no new binding). Auth stays `X-Admin-Key`; putting Cloudflare Access in front of `/admin/*` is a dashboard step documented in `docs/OPERATIONS.md`.
- Active health checks: per-route `healthCheck { path, timeoutMs }`; a Cron Trigger (every minute, in `wrangler.toml`) probes each target and stores the down list in the existing KV namespace (key `health`, written only on change), and the router skips down targets. No new binding. Takes effect on the next deploy; see `docs/LOAD_BALANCING.md`.
- Biome formatter on (`pnpm format`, CI runs `pnpm format:check`): 2 spaces, single quotes, 140 columns, no trailing commas, matching the existing style so the one-time reformat touched few lines.
- Device-aware HMAC, phase 1 (derived keys): optional `deviceKeys` config (`optional` for the transition, `required` to drop the shared key) and a `revoked` list. Each device signs with `HMAC(master, "device:" + id)`. The open questions (web or mobile, login before enrollment) are the backend team's: the enrollment steps are in `docs/hmac/DEVICE_KEYS.md`. Existing clients keep working until `required` is set.
- WebSocket proxying: routes with `"websocket": true` pass a GET `Upgrade: websocket` handshake to the backend and return its 101 response. The handshake goes through the same blocklist, rate limit and HMAC checks, and needs an exact full-origin allowlist (the config is refused without one) because browsers do not apply CORS to sockets; there is no failover or caching for sockets. Tested with a stubbed backend only; try it against a real backend on staging before relying on it. See `docs/CONFIGURATION.md`.
- Backend lock-down (shared secret header): with the `BACKEND_SECRET` Wrangler secret set, every backend request carries it in `X-Proxy-Secret` (name from the optional `BACKEND_SECRET_HEADER`); a client copy is always stripped and route headers cannot override it. The backends must check it: see `docs/BACKEND_LOCKDOWN.md`. mTLS was not done (needs a Cloudflare mTLS binding).
- Per-route options: `timeoutMs`, `methods` (405), `stripPrefix: false` (keep the prefix in the backend path), `headers` (set on the backend request; `Host`, `X-Forwarded-*`, `X-Request-Id` and framing headers are refused) and `allowedOrigins` (replaces the global list for that route, preflight included). All optional and validated. See `docs/CONFIGURATION.md`.
- Request limits: optional top-level `limits` with `allowedMethods` (405 plus `Allow`) and `maxBodyBytes` (413 on a larger declared `Content-Length`), applied to every route and off by default. Chunked bodies declare no length, so they are not capped here; HMAC routes keep their own 1 MB cap. See `docs/CONFIGURATION.md`.
- Request IDs end to end: a valid incoming `X-Request-Id` (1 to 64 of letters, digits, `.`, `_`, `-`) is kept, otherwise `cf-ray` or a new UUID is used. The ID is sent to the backend, returned in the `X-Request-Id` response header (replacing any backend value) and error body, and is in every log line. See `docs/OPERATIONS.md`.
- Docs consolidation: README is a short overview; config, rate-limit settings and examples are in `docs/CONFIGURATION.md`, deploy, admin, errors, logs and troubleshooting in `docs/OPERATIONS.md`. The duplicated README sections and the stale deployment report (moved to `docs/archive/`) are gone, and the real worker hostname was removed from the docs.
- Generated `Env` types: `worker-configuration.d.ts` comes from `wrangler types` (`pnpm types`; CI runs `pnpm types:check`, so a changed `wrangler.toml` must be followed by regenerating it). `Env` in `src/config.ts` extends the generated bindings and lists only the secrets and the optional `METRICS`.
- Pre-commit and commit-msg hooks (`.githooks/`, enabled by `pnpm install`): forbidden-identifier check, employer-email check and typecheck; CI runs `pnpm check:forbidden` over all tracked files.
- Lint and stricter TypeScript: Biome lint (`pnpm lint`, run in CI) and `noUncheckedIndexedAccess` in tsconfig, with the few findings fixed.
- Skip body hashing on safe methods: a request with no body (the usual GET/HEAD) is verified without cloning or reading it; the 1 MB cap and the body-hash check are unchanged. Streaming the hash for large bodies was not done: the body must be buffered to forward it anyway, and the cap bounds it.
- Fewer log lines: `AUTH_SUCCESS` is folded into the request's single log line (one line per request instead of two on HMAC routes), and optional `LOG_SUCCESS_SAMPLE` samples successful lines. Counts live in Analytics Engine. See `docs/CLOUDFLARE_CHANGES.md`.
- Edge caching: per-route `cacheTtl` using the Cache API for GET, never with HMAC routes or credentialed requests. See `docs/EDGE_CACHE.md`.
- Stale-while-revalidate config cache: an expired cache is served at once and refreshed in the background with `executionCtx.waitUntil` (one shared KV read at a time). KV `cacheTtl` was deliberately not added: it would delay config changes by up to another 60 s and the read is no longer on the request path.
- HMAC key IDs and rotation: `X-Key-Id` plus an `AUTH_KEYS` secret, see `docs/KEY_ROTATION.md`.
- Metrics: Analytics Engine `METRICS` binding (approved), one data point per request, see `docs/METRICS.md`. Alerting is documented but not set up: it needs a scheduled query job or Grafana.
- Load balancing: `targets: [...]` per route with weights, one failover retry for `GET`/`HEAD` on connection error, timeout, 502, 503 or 504 (to a different target), and a per-instance circuit breaker (3 failures, 30 s). See `docs/LOAD_BALANCING.md`. Not done from the original item: shared breaker state and active health checks (listed under Features).
- Config as code: shared `validateConfig`, `pnpm validate-config` (also run by `pnpm test` and CI), and the deploy workflow pushes `config/<env>.json` to KV when present. See `docs/CONFIG_AS_CODE.md`. The per-environment config files are not committed yet: that needs your real config.
- Staging and production environments in `wrangler.toml`, a smoke test, and an opt-in deploy workflow with approval for production. Manual Cloudflare and GitHub steps are in `docs/ENVIRONMENTS.md`; nothing was deployed.
- Integration tests: vitest with `@cloudflare/vitest-plugin` (the renamed `@cloudflare/vitest-pool-workers`, which is deprecated and does not support vitest 5). Covers routing, CORS, blocklist, HMAC, device ID, replay, admin and error shapes. `pnpm test` also runs the old HMAC self-check; both run in CI.
- Dependencies upgraded, observability enabled, `compatibility_date` 2026-11-01 (v2.2.0)
- Security hardening from the audit: fail-closed HMAC and admin endpoint, generic errors, secrets via Wrangler, single CORS policy, header stripping, path rejection (v2.2.0)
- Router split into `policy.ts` / `cors.ts`, pnpm only, GitHub Actions CI (v2.2.0)
