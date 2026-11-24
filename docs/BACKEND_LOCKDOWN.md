# Backend lock-down

Without this, anyone who knows a backend's URL can call it directly and skip every check the Worker does (HMAC, rate limits, origin rules). The Worker can send a shared secret with each backend request; a backend that checks it refuses everything else.

## Worker side

```bash
pnpm exec wrangler secret put BACKEND_SECRET --env production    # long random value
```

With the secret set, every request to a backend (including failover retries) carries `X-Proxy-Secret: <value>`.

- A client-supplied `X-Proxy-Secret` is always removed first, and a route's `headers` option cannot override the real value.
- To use another header name, set the plain var `BACKEND_SECRET_HEADER` (letters, digits and hyphens; anything else falls back to the default).
- The secret is per environment. Use a different value for staging.

## Backend side

Reject any request whose `X-Proxy-Secret` does not match, with a constant-time compare. Examples:

```nginx
if ($http_x_proxy_secret != "the-secret") { return 403; }
```

```js
// Express middleware
app.use((req, res, next) =>
  crypto.timingSafeEqual(Buffer.from(req.get('x-proxy-secret') ?? ''), Buffer.from(process.env.PROXY_SECRET))
    ? next() : res.sendStatus(403));
```

(`timingSafeEqual` throws on different lengths; compare lengths first in real code.)

## Rolling it out without downtime

1. Set `BACKEND_SECRET` and deploy. Backends ignore the header for now.
2. Make each backend check the header.
3. Verify direct calls to the backend now get 403 and calls through the Worker still work.

## Rotating

Backends accept the old and the new value for a while, then you update the Worker secret, then backends drop the old value.

## Not covered

mTLS between the Worker and the backend is stronger, but needs a Cloudflare mTLS certificate binding and backend support. It is not implemented. The secret header protects against direct calls, not against someone who can read your Worker secrets or the backend's own logs.
