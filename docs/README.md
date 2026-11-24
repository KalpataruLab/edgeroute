# Documentation index

| Folder | Contents |
|---|---|
| [`hmac/`](hmac/) | HMAC request signing: [HMAC_TOKEN_GUIDE.md](hmac/HMAC_TOKEN_GUIDE.md) (start here), [STRONGER_HMAC_GUIDE.md](hmac/STRONGER_HMAC_GUIDE.md) (Angular client), [SELECTIVE_HMAC_GUIDE.md](hmac/SELECTIVE_HMAC_GUIDE.md) (per-route setup), [DEVICE_KEYS.md](hmac/DEVICE_KEYS.md) (per-device keys), [DEVICE_PROOF.md](hmac/DEVICE_PROOF.md) (non-extractable device keys), [STRICT_REPLAY.md](hmac/STRICT_REPLAY.md) (one-time tokens) |
| [`prompts/`](prompts/) | AI prompts to implement signing: [frontend](prompts/PROMPT_FRONTEND_HMAC_SIGNING.md) (iPhone-safe), [backend](prompts/PROMPT_BACKEND_HMAC_VERIFICATION.md). `ANGULAR_HMAC_IMPLEMENTATION_PROMPT.md` is older and predates body-hash enforcement. |
| [CONFIGURATION](CONFIGURATION.md), [OPERATIONS](OPERATIONS.md) | Config reference; deploy, admin, errors, logs, troubleshooting |
| `ARCHITECTURE.md`, `SECURITY_DIAGRAM.md`, `RATE_LIMITING_IMPLEMENTATION.md` | How the proxy works |
| [ENVIRONMENTS](ENVIRONMENTS.md), [CONFIG_AS_CODE](CONFIG_AS_CODE.md), [LOAD_BALANCING](LOAD_BALANCING.md), [EDGE_CACHE](EDGE_CACHE.md), [KEY_ROTATION](KEY_ROTATION.md), [BACKEND_LOCKDOWN](BACKEND_LOCKDOWN.md), [METRICS](METRICS.md), [CLOUDFLARE_CHANGES](CLOUDFLARE_CHANGES.md) | Feature and setup pages |
| `ROADMAP.md`, `FUTURE_PLANS.md`, `PR_CHECKLIST.md` | Roadmap and pre-merge checklist |
| [`archive/`](archive/) | Historical session reports |

Scripts live in [`../scripts/`](../scripts/). Config: copy `config.example.json` to `config.json` (git-ignored) and never commit real secrets.
