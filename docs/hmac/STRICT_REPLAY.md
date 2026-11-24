# Strict replay protection (optional)

By default the replay check lives in each Worker instance's memory. A captured signed request can only be replayed inside its 30 s window, and only against a **different** instance or data centre than the one that saw it first. With `strictReplay` every verified token is remembered in a Durable Object, so it can be used exactly once everywhere.

```json
{ "strictReplay": true }
```

## How it works

- The check runs **after** the signature is verified, so a forged request cannot use up a real token.
- The token (the HMAC signature) is claimed in one of 16 `ReplayGuard` objects, chosen by its first hex digits, so load is spread. Entries live for twice the window (60 s) and are purged by an alarm. The storage is SQLite-backed and holds nothing else.
- The in-memory check still runs first, so a same-instance replay never needs a Durable Object call.
- It is global: it applies to every route with `hmacRequired`.

## Costs and trade-offs

- One extra Durable Object call (a few ms) per signed request, and Durable Object billing (requests and a little storage). Unsigned routes are untouched.
- **Fail closed.** If the object cannot be reached, or the binding is missing, the signed request is refused (HTTP 503, logged as "Replay check unavailable") rather than waved through. Switch the flag off to go back to the memory-only check.
- The binding `REPLAY` and its migration (`v1`, class `ReplayGuard`) are in `wrangler.toml` for the top level, staging and production. They are created at the next deploy of each environment, whether or not `strictReplay` is on; nothing uses them until the config says so. Staging and production get separate objects.

## Rolling it out

1. Deploy (this creates the Durable Object class). Nothing changes yet.
2. On staging, set `"strictReplay": true` and send the same signed request twice from two different networks; the second must be 401.
3. Watch for `Replay check unavailable` log lines and the extra latency, then enable it in production.

## Not covered

A request replayed **after** the window is rejected by the timestamp check anyway. Nonces are not stored; the signature is what is claimed, which also covers a nonce reused with the same message.
