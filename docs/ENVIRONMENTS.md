# Environments

`wrangler.toml` has two deploy environments. The top-level block is for local dev and tests only; always deploy with `--env`.

| Env | Worker name | KV namespace |
|---|---|---|
| `staging` | `proxy-load-balancer-staging` | its own (ID is a placeholder until you create it) |
| `production` | `proxy-load-balancer` | the existing one, unchanged |

`production` points at the Worker and KV namespace that exist today, so `pnpm deploy:production` replaces the current deployment, not a new one.

```bash
pnpm deploy:staging
pnpm deploy:production
```

## Manual steps (nothing here has been run)

1. Create the staging KV namespace and put its ID in `[[env.staging.kv_namespaces]]`:
   ```bash
   pnpm exec wrangler kv namespace create PROXY_CONFIG --env staging
   ```
2. Load a staging config: `pnpm exec wrangler kv key put config --path=config.json --binding=PROXY_CONFIG --env staging --remote`.
3. Set secrets per environment (they are not shared):
   ```bash
   pnpm exec wrangler secret put AUTH_SALT --env staging
   pnpm exec wrangler secret put ADMIN_KEY --env staging
   ```
   Repeat with `--env production` (production keeps its current secrets if already set).
4. First staging deploy creates the Worker. Note its URL.

## CI deploy (`.github/workflows/deploy.yml`)

Disabled until you opt in. On push to `main`: test, deploy to staging, smoke test (`/health` is 200, `/admin/cache-flush` without a key is 401). Then production waits for approval.

In GitHub, Settings:
- **Secrets** `CLOUDFLARE_API_TOKEN` (Workers edit permission) and `CLOUDFLARE_ACCOUNT_ID`.
- **Variables** `STAGING_URL`, `PRODUCTION_URL`, and finally `DEPLOY_ENABLED=true`.
- **Environments** `staging` and `production`; on `production` add **Required reviewers**. That is the manual approval.

Smoke test by hand: `SMOKE_URL=https://<worker-url> pnpm smoke`.

## Hardening the deploy workflow

- Both jobs only run on `main` (`github.ref` check), so a manual run from another branch cannot deploy.
- On each GitHub environment set **Deployment branches** to `main` only, and store `CLOUDFLARE_API_TOKEN` as an **environment** secret, not a repo secret.
- Use a separate, least-privilege token per environment: the staging token should be able to edit only the staging Worker and KV namespace.
- Actions are referenced by version tag, as in `ci.yml`. Pin them to commit SHAs (Dependabot can keep them current) if you want protection against a moved tag.
