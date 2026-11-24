# HMAC key rotation

Without changes, one secret (`AUTH_SALT`) signs every request. Named keys let you rotate with no window where old clients get 403, and revoke one client alone.

**Server:** set the `AUTH_KEYS` secret to JSON mapping key IDs to secrets. `AUTH_SALT` stays the default key for clients that send no ID.

```bash
pnpm exec wrangler secret put AUTH_KEYS --env production
# value: {"2026-12":"<new secret>","partner-a":"<secret>"}
```

**Client:** send `X-Key-Id: <id>` (letters, digits, `.`, `_`, `-`). The signed message does not change: the ID only selects which secret verifies the signature. The header is not forwarded to the backend. An unknown ID or a wrong secret gives a bare 403; the reason is in the audit log (`keyId` field).

**Rotate:**
1. Add the new key to `AUTH_KEYS` (keep the old one). Deploy is not needed: secrets apply on the next request after `secret put`.
2. Ship clients that sign with the new key and send its ID.
3. When old clients are gone, remove the old key from `AUTH_KEYS`. Those requests now get 403.

**Revoke one client:** give each client its own ID and remove only that entry.

Notes: `AUTH_KEYS` is parsed on every request, so keep it small. A malformed value is ignored (named keys disabled, `AUTH_SALT` still works) and logged. If neither `AUTH_SALT` nor `AUTH_KEYS` is set, HMAC routes still fail closed with 503. The replay cache is shared by all keys.
