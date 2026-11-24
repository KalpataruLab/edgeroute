# Edge cache for GET routes

Set `cacheTtl` (seconds, 1 to 86400) on a route to cache its successful `GET` responses in the Cloudflare Cache API (per data centre).

```json
{ "prefix": "/public", "target": "https://backend.example.test", "hmacRequired": false, "cacheTtl": 60 }
```

Rules, all enforced in code:
- `cacheTtl` is rejected together with `hmacRequired: true`: a shared cache must never hand one caller's authenticated response to another.
- Only `GET` is cached, and never a request that carries `Authorization`, `Proxy-Authorization`, `Cookie`, `X-Auth-Token`, `X-Device-Id`, `X-Key-Id` or `X-Admin-Key` headers (it neither reads nor fills the cache).
- Only `200` responses with a `Content-Length` of 1 MB or less are stored. Responses with `Set-Cookie`, a `Vary` naming anything but `Accept-Encoding`, or a `Cache-Control` of `private`, `no-store`, `no-cache` or a zero `max-age`/`s-maxage` are not.
- The cache key is the full client URL (path and query). Stored entries get `Cache-Control: public, max-age=<cacheTtl>`: `cacheTtl` is the operator opting that route in, so it overrides a missing or longer backend lifetime. Only enable it on routes whose response is the same for every anonymous caller.
- Cache hits skip the backend but still pass the blocklist, rate limit, Turnstile and origin checks, and get the current CORS headers. They carry `X-Cache: HIT` and are logged and counted in metrics with `auditType: CACHE_HIT`.

Limits: entries expire after `cacheTtl` and are not purged by the admin cache flush (that flushes the config cache only). Streamed responses with no `Content-Length` are not cached.
