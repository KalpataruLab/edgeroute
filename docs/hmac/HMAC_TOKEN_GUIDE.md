# HMAC Token Verification: Developer Guide

How the proxy verifies HMAC tokens, how to generate the shared secret safely, and how to hand it to another developer.

Source of truth: [`src/auth.ts`](../../src/auth.ts) (`verifyStrongerHMAC`) and the call site in [`src/router.ts`](../../src/router.ts). See also [STRONGER_HMAC_GUIDE.md](STRONGER_HMAC_GUIDE.md) for the Angular client code.

---

## 1. What is verified

HMAC-SHA256 over a canonical request string, keyed with a shared secret (the `AUTH_SALT` Wrangler secret; `authSalt` in the KV config is a legacy fallback).

Verification only runs on routes with `"hmacRequired": true`. If such a route has no secret configured, the Worker returns 503 (fail closed). Other routes skip it.

### Request headers the client must send

| Header | Value |
|---|---|
| `X-Auth-Token` | lowercase hex HMAC-SHA256 of the message below |
| `X-Timestamp` | `Date.now()` in **milliseconds** |
| `X-Nonce` | random, single use (`crypto.randomUUID()`) |
| `X-Body-Hash` | hex SHA-256 of the body, or empty string when there is no body |

### Message that is signed

```
{timestamp}|{METHOD}|{pathname + search}|{bodyHash}|{User-Agent}|{nonce}
```

- `METHOD` is upper case.
- `pathname + search` is the path as the worker sees it, including the query string.
- `User-Agent` must be the exact header the worker receives (empty string if absent).
- Any byte of difference gives `403`.

### Server checks, in order

| # | Check | Failure |
|---|---|---|
| 1 | `X-Auth-Token`, `X-Timestamp`, `X-Nonce` present | `400` |
| 2 | Timestamp is a number | `400` |
| 3 | `abs(now - timestamp) <= 30s` | `401` |
| 4 | Nonce not already seen by this Worker instance (in-memory, no KV) | `401` |
| 5 | Recompute HMAC, compare with `X-Auth-Token` | `403` |
| 6 | Nonce is reserved at step 4 and kept for 60s (2x window); released if a later check fails | n/a |

Failures return an **empty body** with only the status code. The reason goes to the audit log (`HMAC_VERIFICATION_FAILED`), never to the client. Successful verification also lifts the caller into the authenticated rate-limit tier.

---

## 2. Generating the secret

The secret is used as a raw UTF-8 string, so any high-entropy printable string works. Use **at least 32 random bytes (256 bits)** from a CSPRNG. Never type one by hand or derive it from a word or a date.

Pick one:

```bash
# OpenSSL
openssl rand -base64 32
```

```bash
# Node (no OpenSSL needed)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```powershell
# PowerShell 7
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Rules:

- Generate it **on your own machine**, directly into the password manager or `wrangler secret put`. Do not paste it into a chat, ticket, doc or AI assistant to "check" it.
- One secret **per environment** (dev, staging, prod). Never reuse prod's secret elsewhere.
- Never commit it. See section 5.

---

## 3. Where the secret lives

The worker reads it from the config as `authSalt`.

| Place | Secret stored as | Notes |
|---|---|---|
| Worker config (KV key `config`, uploaded from `config.json`) | `authSalt` | Current mechanism. `config.json` is a local, git-ignored file. |
| Client (Angular app) | constant in the bundle | Required for the client to sign. **Visible to anyone who opens the bundle** (section 6). |

Local development: copy `config.example.json` to `config.json`, replace `authSalt` with a freshly generated dev secret, and upload with:

```bash
wrangler kv:key put --namespace-id=<ID> "config" --path=config.json
```

---

## 4. Sharing the secret with another developer

Do:

1. Store it in the team **password manager** (shared vault entry per environment) and share access there. Access is logged and revocable.
2. If there is no shared vault, use a **one-time, expiring secret link** from a tool the team already trusts, and send the link, not the value. Confirm out-of-band that the person opened it.
3. Give each developer the **dev/staging** secret only. Production secret access goes to the smallest group that deploys.
4. Record who has which environment's secret in the password manager's access list, not in the repo.

Don't:

- Email it, paste it in Slack/Teams/tickets/PR comments, or put it in a screenshot.
- Commit it, even to a private repo, even "temporarily" (git history is forever).
- Put it in logs, test fixtures, docs or examples. Use obvious placeholders (`replace-with-long-random-secret-string`).
- Share the prod secret to "just test something". Generate a dev one.

Verify a received secret works without ever printing it:

```bash
# read the secret into a variable without echoing it, then run the curl test from STRONGER_HMAC_GUIDE.md
read -rs SECRET
```

---

## 5. Rotation and revocation

Rotate when: a developer with access leaves, the secret appears anywhere it should not (repo, chat, log), or on a schedule (suggest every 90 days).

Procedure:

1. Generate a new secret (section 2).
2. Update the worker config (`authSalt`) and upload to KV.
3. Ship the Angular build with the new value at the same time.
4. Old clients get `403` until they update. The worker currently supports **one** secret at a time, so plan a short window, or add dual-secret support (accept `authSalt` and `authSaltPrevious`) if zero-downtime rotation matters.
5. Update the password manager entry and tell holders.

If a secret leaks: rotate immediately, then check audit logs for `AUTH_SUCCESS` entries from unknown IPs.

---

## 6. Honest limits: what this does and does not protect

The signing secret has to exist in the browser bundle, so a determined attacker can extract it and sign their own requests. This scheme:

- **Stops**: casual copying of requests, simple replay (nonce), stale tokens (30s window), bots that do not read the bundle.
- **Does not stop**: someone who reads the JS bundle. Pair it with Turnstile and rate limiting (already in this worker), or move signing to a backend (BFF) so the secret never reaches the browser.

Treat "shared with developers" and "shipped to browsers" as two different exposure levels: the former you control with section 4, the latter you cannot.

---

## 7. Known gaps

Fixed in this branch:

- **Constant-time compare:** the token is now compared with a constant-time loop (`timingSafeEqual` in `src/auth.ts`).
- **Body hash enforced:** the worker hashes the real request body and rejects (`403`) if it differs from `X-Body-Hash`. Clients must send the hash of exactly the bytes they send (the Angular `JSON.stringify(body)` approach in STRONGER_HMAC_GUIDE.md does this).
- **`config.json` untracked** (`git rm --cached`). It stays on disk and is ignored. **The old `authSalt` is in git history: rotate it** (section 5).

Still open:

1. **Nonce replay protection is per Worker instance (in memory).** A replay inside the 30 s window that lands on a different instance or location is not caught. A Durable Object gives strict one-time use; it needs a new binding in `wrangler.toml`, so it is a separate change.
2. Invalid attempts are not limited by nonce (only by the IP rate limiter).

---

## 8. Quick troubleshooting

| Status | Likely cause |
|---|---|
| `400` | A required header is missing, or the timestamp is not a number. (A timestamp in seconds instead of ms is a valid number, so it shows as `401`.) |
| `401` | Clock skew over 30s (check the client clock and that the timestamp is in ms), or the nonce was reused. |
| `403` | Message mismatch: wrong method case, query string left out, different `User-Agent`, body hash mismatch, or a different secret. |

Server-side detail is in the audit log entry `HMAC_VERIFICATION_FAILED` (`reason` field).
