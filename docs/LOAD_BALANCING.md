# Load balancing and failover

A route can list several backends. The single `target` form still works unchanged.

```json
{
  "prefix": "/api",
  "targets": [
    "https://api-a.example.test",
    { "url": "https://api-b.example.test", "weight": 3 }
  ],
  "hmacRequired": true
}
```

- Every target must be `https`. `weight` is a positive number, default 1. If only `targets` is set, `target` is filled in from the first entry.
- **Selection:** weighted random, skipping targets whose circuit is open.
- **Failover:** `GET` and `HEAD` only. On a connection error, a timeout, or a 502, 503 or 504, the request is sent once to a different target. A second failure returns that backend's response (or the generic 503 / 504). Other statuses (404, 500, ...) are returned as they are. `POST`, `PUT`, `PATCH` and `DELETE` are never retried, because the request body is a stream that cannot be replayed. A route with one target is never retried.
- **Timeout:** `REQUEST_TIMEOUT` applies per attempt, so a failed-over request can take up to twice as long.
- **Circuit breaker:** 3 consecutive failures open a target's circuit for 30 s, then it is tried again; a success closes it. If every target is open, one is tried anyway (fail open).
- Failovers are logged with `auditType: FAILOVER` and the attempt number.

## Active health checks

Passive checks only notice a dead backend after real requests fail. A route with two or more `targets` can also set `healthCheck`:

```json
{ "prefix": "/api", "targets": ["https://api-a.example.test", "https://api-b.example.test"], "healthCheck": { "path": "/healthz", "timeoutMs": 3000 } }
```

A Cron Trigger (every minute, set in `wrangler.toml`) sends `GET <target><path>` to each target. A target is **down** if it times out, cannot be reached, or answers 5xx; any other status (even 401 or 404) counts as alive. The down list is stored in the existing `PROXY_CONFIG` KV namespace under the key `health` (no new binding), written only when it changes or every 5 minutes. Each Worker instance reads it at most every 30 s and skips down targets exactly like an open circuit (if every target is down, one is tried anyway). A record older than 15 minutes is ignored, so a stopped cron never leaves targets marked down. The probe carries `BACKEND_SECRET` when set, so a locked-down backend accepts it. Routes without `healthCheck` are unaffected and the cron does nothing for them.

Timing: a failure shows up within about a minute, plus up to 30 s for instances to reload it. Keep the health path cheap and public to the proxy (it is not HMAC signed).

Limits: breaker state lives in each Worker instance's memory, like the rate limiter and replay cache, so instances learn about a dead backend separately. Active health checks (above) give instances a shared view.

Abuse note: breaker state is kept per route (prefix + target), so traffic on one route, for example a public one, cannot open a circuit used by another route that shares the backend. A client who can make a backend answer 502/503/504 on a public route can still steer that route's traffic away from the target for 30 s on that Worker instance; it only ever chooses among the targets you configured, and if all are open one is tried anyway.
