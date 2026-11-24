# Prompt: Implement HMAC request verification in the backend

Copy everything below the line into your AI coding assistant, inside the backend repo.

---

## Task

Add HMAC-SHA256 request verification to this backend. A reference implementation exists in Cloudflare Worker form (`src/auth.ts`, `verifyStrongerHMAC`, called from `src/router.ts`). If this backend is that Worker, review and harden it. If it is another stack (Node, .NET, PHP, Python, Java), port the same behaviour exactly. The browser client (including iPhone Safari) signs requests with the algorithm below, so the output must match byte for byte.

Find the existing middleware or request pipeline first and hook into it. Do not add a new framework.

## Algorithm

```
message  = X-Timestamp + "|" + METHOD_UPPERCASE + "|" + pathname + search + "|" + X-Body-Hash + "|" + User-Agent + "|" + X-Nonce
expected = lowercase_hex(HMAC_SHA256(key = utf8(secret), data = utf8(message)))
```

Request headers: `X-Auth-Token`, `X-Timestamp` (milliseconds), `X-Nonce`, `X-Body-Hash` (empty string when there is no body).

**Optional `X-Device-Id`** (8-64 characters of `[A-Za-z0-9._-]`): when the header is present, append `"|" + X-Device-Id` to the message; when absent, the message is unchanged (existing clients keep working). A present but malformed value is rejected with 400. It is an audit label only, not authentication, because the secret is shared. Log it as `deviceId` on both success and failure entries so per-device anomalies can be found (one ID from many IPs or user agents, bursts of failures).

**Ambiguity rule:** fields are joined with `|`, so reject a nonce containing `|` (400). Key the replay store on the computed or received token (signature), not on the raw nonce header, so a request re-sent with shifted field boundaries cannot dodge the replay check.

`pathname + search` must be the path as the client signed it. If a reverse proxy rewrites the path or strips a prefix before your code runs, rebuild the original, or verify at the outermost layer. A mismatch here is the most common cause of 403.

## Verification order (do not reorder, do not skip)

| # | Check | Failure status |
|---|---|---|
| 1 | `X-Auth-Token`, `X-Timestamp`, `X-Nonce` present | 400 |
| 2 | `X-Timestamp` parses as an integer | 400 |
| 3 | `abs(now_ms − timestamp) <= 30000` (configurable) | 401 |
| 4 | Not seen before (key `replay:<token>`; reject nonces containing a pipe first with 400) | 401 |
| 5 | If a body exists: `lowercase_hex(SHA256(raw body bytes)) == X-Body-Hash`. If no body: `X-Body-Hash` must be empty. Compare in constant time. | 403 |
| 6 | Recompute the HMAC and compare with `X-Auth-Token` **in constant time** | 403 |
| 7 | Only after success, store the nonce with a TTL of 2 × the window (60 s) | n/a |

Hard rules:
- **Never trust `X-Body-Hash` by itself.** Hash the real body you received. Read the body in a way that does not consume it for the downstream handler (clone the request, or buffer it once).
- **Constant-time comparison** for steps 5 and 6. Use the platform primitive (`crypto.timingSafeEqual`, `hash_equals`, `hmac.compare_digest`, `MessageDigest.isEqual`, `CryptographicOperations.FixedTimeEquals`). Never `==` or `!==`. Check lengths first, since both are hex digests of known length.
- **Failures return an empty body and only the status code.** No reason text, no hints, no stack trace. Write the reason to the server-side audit log only.
- **Never log** the secret, the token, or the full message. Log nonce, route, client IP, status, and a reason code.
- Only verify on routes flagged as protected. Keep the flag in route config (`hmacRequired`), not hard-coded paths.
- Do not leak timing between "unknown nonce" and "bad signature". Keep the order above.

## Nonce storage

- A shared store is required if more than one instance or edge location serves traffic (Redis `SET key value NX EX 60` is the correct atomic primitive; in Cloudflare use a Durable Object).
- Do the check-and-set **atomically** where the store supports it. Reserve the nonce with set-if-absent and treat "already exists" as a replay. If you cannot make it atomic (for example plain Cloudflare KV, which is eventually consistent), state that limit in your report.
- If the store is unreachable, **fail closed** (reject with 503 or 401), never allow.

## CORS (needed for browser and iPhone clients)

The four custom headers cause a preflight `OPTIONS` request, which must succeed **without** HMAC checking.
- `Access-Control-Allow-Headers` must include `X-Auth-Token, X-Timestamp, X-Nonce, X-Body-Hash, X-Device-Id, Content-Type`.
- `Access-Control-Expose-Headers` must include `Date` so the client can correct its clock. iPhones often have wrong clocks.
- Do not use `*` for allowed origins together with credentials. Keep the explicit origin allow-list.
- The response must always carry a standard `Date` header.

## Secret handling

- Load the secret from the platform secret store or environment (`wrangler secret put`, a vault, or an env var), not from a tracked file. If it currently lives in a tracked config file, move it and tell me.
- Generate secrets with a CSPRNG, at least 32 random bytes (`openssl rand -base64 32`). Use one secret per environment.
- Optional but recommended: accept a current and a previous secret during rotation (try current, then previous) so rotation needs no downtime.

## Deliverables

1. The verification function or middleware, with a typed result `{ valid, reason?, statusCode? }`, and its wiring into the existing pipeline for protected routes only.
2. CORS changes as described above.
3. Tests (the project's existing test runner; if none, a plain script with assertions) covering the test vectors below and each failure row: missing headers (400), bad timestamp (400), expired and future-dated timestamp (401), reused nonce (401), tampered body with an unchanged header (403), tampered path (403), tampered method (403), wrong secret (403), wrong User-Agent (403), a no-body request with an empty hash, a signed device ID (200 and logged), a device ID sent but not signed (403), a malformed device ID (400), and a nonce containing `|` (400).
4. A short README section: header contract, status codes, secret generation and rotation, and the known limits.

## Test vectors (must pass exactly)

Secret: `test-secret-do-not-use-in-production`

Vector 1, with body:
- method `POST`, path `/api/data?x=1`, raw body `{"a":1}`
- `X-Timestamp` `1700000000000`
- `X-Nonce` `11111111-1111-4111-8111-111111111111`
- `User-Agent` `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) TestUA`
- `X-Body-Hash` `015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862`
- expected `X-Auth-Token` `7007f4ddbb9d2f20d3ba75b7703f9edbfea99a0bdc8ccb32897a0c37105042b6`

Vector 2, no body:
- method `GET`, path `/api/data`
- `X-Timestamp` `1700000000000`
- `X-Nonce` `22222222-2222-4222-8222-222222222222`
- `User-Agent` `curl/8.0`
- `X-Body-Hash` empty
- expected `X-Auth-Token` `eb17b195760a3dbbc16a621ffd73db66f6f63385536b4eea2a5bda9881645c06`

In tests, inject the clock (pass `now`) so the 1700000000000 timestamps are valid.

## Known limits to state in your final report

- The signing secret is embedded in the browser app, so a determined attacker can extract it. This scheme blocks forged, replayed and tampered requests from anyone who has not extracted the secret. It does not replace bot protection or rate limiting.
- The nonce check is only as strong as the store's atomicity.

Do not mark the task done on "it compiles". Report what you ran, what passed, and what you could not verify.
