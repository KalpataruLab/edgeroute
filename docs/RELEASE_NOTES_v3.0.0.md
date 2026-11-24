# v3.0.0 release notes

Everything since v2.2.0 (about 70 commits, PRs #20 to #48). Nothing was deployed from this work: the first deploy of each environment applies the changes below.

## Upgrade notes (read first)

Existing configs and clients keep working. All new behaviour is off until the config asks for it. What changes on the first deploy:

- **New bindings and a trigger in `wrangler.toml`** (top level, staging and production): an Analytics Engine dataset `METRICS`, a Durable Object `REPLAY` (class `ReplayGuard`, migration `v1`), and a Cron Trigger every minute. The cron does nothing unless a route sets `healthCheck`; the Durable Object is unused unless `strictReplay` is set.
- **Environments:** deploy with `--env staging` or `--env production`. The staging KV namespace id is still a placeholder (`docs/ENVIRONMENTS.md`).
- **Default export** is now `{ fetch, scheduled }` (needed for the cron).
- **WebSocket routes** need an exact full-origin allowlist, or the config is refused at load.
- Config validation is stricter for the new options only; a config that loads today still loads.

## What is new

**Routing and reliability**
- Several `targets` per route with weights, failover for GET/HEAD, per-route circuit breaker, and optional active health checks (`healthCheck`) shared through the existing KV.
- Per-route options: `timeoutMs`, `methods`, `stripPrefix`, `headers`, `allowedOrigins`, `websocket`, `cacheTtl`.
- Global `limits` (method allowlist, `maxBodyBytes`). Request IDs end to end (`X-Request-Id`).
- WebSocket proxying per route, with an exact-origin allowlist. Edge cache for GET.
- Stale-while-revalidate config cache; bodyless requests skip body hashing; one log line per request with optional sampling.

**Security**
- Backend lock-down: `BACKEND_SECRET` is sent to backends so they can refuse traffic that skipped the proxy.
- HMAC key rotation (`X-Key-Id`, `AUTH_KEYS`).
- Per-device keys (`deviceKeys`: `optional` or `required`, plus `revoked`), and proof of possession with enrolled non-extractable ECDSA keys (`deviceKeys.proof`).
- Strict one-time tokens across instances (`strictReplay`, Durable Object, fails closed).
- Fail-closed behaviour and the 1 MB signed-body cap are unchanged.

**Operations**
- Staging and production environments, smoke test, opt-in deploy workflow with approval for production.
- Config as code (`pnpm validate-config`, pushed to KV by the deploy workflow).
- Admin API: `GET/PUT /admin/config`, history, rollback, with validation and the last 20 revisions.
- Analytics Engine metrics (`docs/METRICS.md`).

**Quality**
- Integration tests (vitest with the Workers plugin; 234 tests), Biome lint and formatter in CI, strict TypeScript, generated `Env` types, pre-commit hooks.
- Docs reorganised: README overview, `docs/CONFIGURATION.md`, `docs/OPERATIONS.md`.

## Not done

- In-Worker rate limiter is still there (off unless configured). Remove it after the Cloudflare edge rule is live.
- mTLS between the Worker and backends (needs a Cloudflare mTLS binding).
- Client-side work for device proof (`docs/hmac/DEVICE_PROOF.md`), backend enrollment endpoints, and a real-backend WebSocket test.
- Metrics alerting is documented only.

## Manual steps before or at release

1. Staging KV namespace id and per-environment secrets (`AUTH_SALT`, `ADMIN_KEY`, optional `AUTH_KEYS`, `BACKEND_SECRET`).
2. GitHub secrets, variables, environments and `DEPLOY_ENABLED` (`docs/ENVIRONMENTS.md`).
3. Commit `config/staging.json` and `config/production.json`.
4. Deploy staging, run the smoke test, try WebSocket and the new options there.
5. Deploy production after staging looks good.
