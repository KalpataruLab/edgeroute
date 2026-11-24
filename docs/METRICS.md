# Metrics and alerts

Each finished request writes one Analytics Engine data point to the `METRICS` binding (dataset `proxy_metrics` in production, `proxy_metrics_staging` in staging). A missing binding or a failed write never affects a request.

| Field | Content |
|---|---|
| `index1` | route prefix |
| `blob1` | route prefix |
| `blob2` | HTTP method |
| `blob3` | audit type, empty for a normal proxied response (`HMAC_VERIFICATION_FAILED`, `RATE_LIMIT_EXCEEDED`, `ORIGIN_BLOCKED`, `BLOCKLIST_HIT`, `PATH_REJECTED`, ...) |
| `blob4` | backend origin and path (no query) |
| `blob5` | `X-Key-Id` used for HMAC, if any |
| `double1` | status |
| `double2` | latency in ms |

The dataset is created the first time the Worker writes to it. No query string, header value or IP address is stored.

## Example queries (Cloudflare SQL API)

```sql
-- requests, errors and p95 latency per route, last hour
SELECT blob1 AS route, SUM(_sample_interval) AS requests,
       SUM(IF(double1 >= 500, _sample_interval, 0)) AS errors,
       quantileWeighted(0.95)(double2, _sample_interval) AS p95_ms
FROM proxy_metrics WHERE timestamp > NOW() - INTERVAL '1' HOUR GROUP BY route

-- HMAC failures per 5 minutes
SELECT intDiv(toUInt32(timestamp), 300) * 300 AS t, SUM(_sample_interval) AS failures
FROM proxy_metrics WHERE blob3 = 'HMAC_VERIFICATION_FAILED' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY t ORDER BY t
```

## Alerts (manual)

Analytics Engine has no built-in alerting. Options, none of which are set up:
- A scheduled job (GitHub Actions cron or a Cloudflare Cron Trigger) that runs the HMAC and `RATE_LIMIT_EXCEEDED` queries above through the SQL API and notifies you when a count passes a threshold. This needs an API token with Account Analytics read permission.
- A Grafana data source on the Analytics Engine SQL API, with alert rules on the same queries.

Suggested starting thresholds: alert when `HMAC_VERIFICATION_FAILED` or `RATE_LIMIT_EXCEEDED` in 5 minutes is more than 5 times the previous day's average, and when 5xx errors on a route exceed 5 percent.

## Manual steps

Nothing to create in advance. After the next deploy of each environment, check that data arrives (Dashboard, Workers, Analytics Engine, or run the first query). Local dev and tests use the `proxy_metrics_dev` dataset name and need no setup.
