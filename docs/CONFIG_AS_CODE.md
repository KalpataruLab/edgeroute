# Config as code

The route config can live in git instead of being edited in KV by hand.

- `config/staging.json` and `config/production.json` are the source of truth for each environment. They are **not created yet**: copy `config.example.json`, edit, and commit them when you are ready.
- Secrets never go in these files. `pnpm validate-config` fails if `authSalt` or `turnstileSecretKey` is set in `config/*.json`; use `wrangler secret put AUTH_SALT --env <env>`.
- Do not commit real hostnames or internal names you consider private; review the diff first.

## Validate

```bash
pnpm validate-config                   # config.example.json and config/*.json
pnpm validate-config config/staging.json
pnpm validate-config --strict          # warnings also fail
```

It calls the same `validateConfig` the Worker uses on every KV load, so anything the Worker would reject (no `routes` array, a prefix without `/`, a target that is not `https`) fails here first. Warnings (never blocking): `hmacRequired` not set, duplicate prefixes, non-string origin lists, a rate limit with no positive numbers. `pnpm test` runs it, so CI checks every committed config.

## Push to KV

`deploy.yml` validates and uploads `config/<env>.json` after each deploy, and skips the step when the file does not exist. By hand:

```bash
pnpm validate-config config/staging.json
pnpm exec wrangler kv key put config --path=config/staging.json --binding=PROXY_CONFIG --env staging --remote
```

The Worker caches config for 60 s. To apply it at once, call `POST /admin/cache-flush` with `X-Admin-Key`.

## Before the first production push

KV currently holds your live config. Download it first (`wrangler kv key get config --binding=PROXY_CONFIG --env production --remote > config/production.json`), strip any `authSalt` / `turnstileSecretKey`, validate, and commit that, so the first CI push does not change anything unintended.
