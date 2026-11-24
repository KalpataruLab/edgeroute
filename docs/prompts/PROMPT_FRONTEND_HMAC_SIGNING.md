# Prompt: Implement HMAC request signing in the frontend (iPhone-safe)

Copy everything below the line into your AI coding assistant, inside the frontend repo.

---

## Task

Add HMAC-SHA256 request signing to this frontend so every call to our API proxy carries a valid signature. The backend already verifies it. Do not change the algorithm. It must work in current desktop browsers and **iPhone Safari, Chrome iOS and Edge iOS (all WebKit), iOS 15 and later**.

Framework: <Angular | React | Vue | plain fetch>. Adapt to the codebase's existing HTTP layer (interceptor, axios instance, or fetch wrapper). Find the existing one first and hook into it. Do not add a second HTTP stack.

## Algorithm (must match the backend byte for byte)

```
nonce     = random UUID v4, new for EVERY request
timestamp = server-corrected Date.now() in MILLISECONDS, as a decimal string
bodyHash  = body present ? lowercase_hex(SHA256(utf8(bodyString))) : ""   // "" when no body
message   = timestamp + "|" + METHOD_UPPERCASE + "|" + pathname + search + "|" + bodyHash + "|" + userAgent + "|" + nonce
token     = lowercase_hex(HMAC_SHA256(key = utf8(secret), data = utf8(message)))
```

Send these headers on every protected request:

| Header | Value |
|---|---|
| `X-Auth-Token` | token |
| `X-Timestamp` | timestamp |
| `X-Nonce` | nonce |
| `X-Body-Hash` | bodyHash (empty string if no body) |
| `X-Device-Id` | deviceId (optional, see below) |

### Optional device ID (audit trail)

Give each install a random device ID so the proxy can log per-device activity and flag anomalies.

```
deviceId = 8-64 chars of [A-Za-z0-9._-], generated once with crypto.getRandomValues (or a UUID v4), persisted on the device
message  = <message above> + "|" + deviceId        // append ONLY when X-Device-Id is sent; otherwise unchanged
```

- Web: persist in `localStorage` (fall back to an in-memory value if storage is blocked, for example Safari private mode). Mobile apps: use the platform's secure storage (Keychain / Keystore). Do not derive it from hardware identifiers or personal data.
- Send the same value in the `X-Device-Id` header on every request, and include it in the signed message every time. A header that is sent but not signed gets a `403`; a malformed value gets a `400`.
- It is an audit label, **not authentication**: the secret is still shared, so anyone who has it can claim any ID.
- Add `X-Device-Id` to the CORS preflight allow-list (the proxy already allows it).

Rules that commonly break:
- The nonce must not contain `|`. A UUID v4 or lowercase hex is fine.
- `pathname + search` is exactly what goes on the wire, with the query string in the same order and encoding. No hash fragment. No origin.
- `userAgent` is `navigator.userAgent`, which must equal the `User-Agent` request header the server sees. Never override the User-Agent header.
- The body hash must cover **exactly the bytes sent**. Serialize the body to a string **once** (`JSON.stringify`), hash that string, and send that same string. Never hash an object and let the library serialize it again (key order or whitespace can differ and the server returns 403).
- Only string bodies are supported. If the app sends FormData, Blob or files, tell me instead of guessing.
- Lowercase hex only, zero-padded per byte.

## iPhone / Safari requirements

1. **Secure context only.** `crypto.subtle` is undefined on plain `http://` pages in Safari (for example `http://192.168.x.x` LAN testing). Detect `window.isSecureContext && crypto?.subtle`; if missing, log a clear error and do not send an unsigned request silently. Document that iPhone testing needs HTTPS (a tunnel such as Cloudflare Tunnel, or a trusted local cert).
2. **No `crypto.randomUUID()` assumption.** It needs Safari 15.4+. Use it when present, otherwise build a UUID v4 from `crypto.getRandomValues`. Never use `Math.random`.
3. **Clock skew.** iPhones often have a wrong manual time, and the server allows only ±30 s. Compute a clock offset from the `Date` response header of any API response (`offset = serverTime − Date.now()` at response time), store it in memory, and add it to every timestamp. On a `401`, refresh the offset and **retry the request once** with a new nonce. Never retry more than once. Never reuse a nonce.
4. **CORS preflight.** The four custom headers trigger an `OPTIONS` preflight. Do not try to avoid it. Confirm the backend allows them (see the backend prompt) and that `Date` is exposed via `Access-Control-Expose-Headers` so the offset logic can read it. If the frontend and API are same-origin, skip this.
5. **Use only `TextEncoder`, `crypto.subtle`, `crypto.getRandomValues`.** No Node `crypto`, no `Buffer`, no polyfills that need a build change, no new dependencies.
6. **Do not cache the signed headers.** Every request, including retries and polling, gets a fresh nonce and timestamp.
7. In-app browsers and iOS content blockers can alter the User-Agent header. If a `403` appears only on one iOS browser, say so in your report instead of working around it.

## Secret handling

- Read the secret from the build-time environment config (for example `environment.hmacSecret`), never hard-code it in source. Add the env file to `.gitignore` and commit only an example file with a placeholder.
- Do not log the secret, the token, or the full message.
- The secret ships to browsers, so it only raises the bar against casual abuse. Mention this limit in the PR description.

## Deliverables

1. A single signing module with these functions: `getSecureCrypto()`, `uuidV4()`, `sha256Hex(string)`, `hmacSha256Hex(secret, message)`, `getDeviceId()`, `buildSignedHeaders(method, url, bodyString | undefined)` and the clock-offset helpers. `buildSignedHeaders` sends `X-Device-Id` and signs it when the device ID feature is enabled.
2. The hook into the existing HTTP layer. It signs only requests to our API base URL(s), serializes the body once, sends exactly that string, and does the single 401 retry.
3. Unit tests that run without a browser using Node 18+ `globalThis.crypto`, covering the test vectors below, plus: no body gives an empty hash, nonces differ across calls, and the UUID fallback produces a valid v4.
4. A short README section: how to set the secret per environment, how to test on an iPhone (HTTPS requirement), and how to debug a 400/401/403.

## Test vectors (your implementation must reproduce these exactly)

Secret: `test-secret-do-not-use-in-production`

Vector 1, with body:
- method `POST`, path `/api/data?x=1`, body string `{"a":1}`
- timestamp `1700000000000`
- nonce `11111111-1111-4111-8111-111111111111`
- userAgent `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) TestUA`
- bodyHash `015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862`
- token `7007f4ddbb9d2f20d3ba75b7703f9edbfea99a0bdc8ccb32897a0c37105042b6`

Vector 2, no body:
- method `GET`, path `/api/data`, bodyHash empty
- timestamp `1700000000000`
- nonce `22222222-2222-4222-8222-222222222222`
- userAgent `curl/8.0`
- token `eb17b195760a3dbbc16a621ffd73db66f6f63385536b4eea2a5bda9881645c06`

## Acceptance checks

- Both vectors pass in the unit tests.
- A real request from desktop Chrome returns 200 from the proxy.
- A real request from an iPhone over HTTPS returns 200. If you cannot test on a device, say so explicitly.
- Replaying the same request (same nonce) returns 401.
- With a device ID: the same device ID is sent on every request, requests with it return 200, and the proxy log shows `deviceId` on `AUTH_SUCCESS`. Unit-test the signed message with and without the ID (the token differs, and without the ID the vectors below still pass).
- No new runtime dependencies.

Do not mark the task done on "it compiles". Report what you actually ran and what you could not verify.
