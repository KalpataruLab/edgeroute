# Rate Limiting Implementation Summary

**Date:** February 2, 2026  
**Strategy:** Option C - Hybrid Approach (In-memory + KV for bans)

## ✅ Implementation Complete

### Files Modified

1. **[src/config.ts](../src/config.ts)** - Added rate limit configuration schema
2. **[src/router.ts](../src/router.ts)** - Integrated rate limit checks + wildcard origin support
3. **[src/ratelimit.ts](../src/ratelimit.ts)** - NEW: Rate limiting module with fixed window algorithm
4. **[config.example.json](../config.example.json)** - Added example configurations
5. **[README.md](README.md)** - Added rate limiting documentation

### Key Features Implemented

#### 1. **Granularity** ✓
- ✅ Per-IP baseline (using `CF-Connecting-IP` header)
- ✅ Per-route multipliers (adjust limits per endpoint)
- ✅ HMAC authenticated user bypass/multiplier

#### 2. **Algorithm** ✓
- ✅ Fixed window (efficient, simple for edge computing)
- ✅ In-memory Map storage (per-isolate, ephemeral)
- ✅ Automatic cleanup of old entries (every 10 minutes)

#### 3. **Response Pattern** ✓
- ✅ Authenticated users: `429 Too Many Requests` + `Retry-After` header + JSON body
- ✅ Anonymous users: `403 Forbidden` (silent, consistent with HMAC pattern)
- ✅ Audit logging: `RATE_LIMIT_EXCEEDED` event type

#### 4. **Bonus: Wildcard Origin Support** ✓
- ✅ `*.aesysit.com` now matches `app.aesysit.com`, `api.aesysit.com`, etc.
- ✅ Supports both hostname patterns and full URL matching

## Configuration Structure

```typescript
interface ProxyConfig {
  rateLimit?: {
    enabled: boolean;              // Enable/disable rate limiting
    requestsPerWindow: number;     // Baseline limit (e.g., 300)
    windowSeconds: number;         // Time window in seconds (e.g., 300 = 5 min)
    hmacBypass?: boolean;          // If true, HMAC users bypass limits
    hmacMultiplier?: number;       // Multiplier for HMAC users (e.g., 2.0 = double)
  };
  routes: Array<{
    prefix: string;
    target: string;
    hmacRequired?: boolean;
    rateLimitMultiplier?: number; // Per-route multiplier (0.5 = half, 2.0 = double)
  }>;
}
```

## Example: Update Your config.json

```json
{
  "routes": [
    { 
      "prefix": "/api/data", 
      "target": "https://vapi.aesysit.com/api/data", 
      "hmacRequired": true,
      "rateLimitMultiplier": 1.0
    },
    { 
      "prefix": "/api/Data", 
      "target": "http://demo.lazycoder.ninja/api/Data", 
      "hmacRequired": true,
      "rateLimitMultiplier": 0.5
    },
    { 
      "prefix": "/", 
      "target": "https://aesysit.com",
      "rateLimitMultiplier": 2.0
    }
  ],
  "allowedOrigins": [
    "*.aesysit.com",
    "voteforsmjahangir.com",
    "http://localhost:3000"
  ],
  "blockedOrigins": [
    "dhaka18-site.pages.dev"
  ],
  "rateLimit": {
    "enabled": true,
    "requestsPerWindow": 300,
    "windowSeconds": 300,
    "hmacBypass": false,
    "hmacMultiplier": 2.0
  },
  "authSalt": "replace-with-complex-random-string",
  "turnstileSecretKey": "",
  "version": "1.0"
}
```

### What This Does

With the above configuration:

- **Baseline:** 300 requests per 5 minutes per IP
- **HMAC authenticated users:** 600 requests per 5 minutes (300 × 2.0)
- **Routes:**
  - `/api/data` (authenticated): 600 requests/5min (baseline × 2.0 HMAC multiplier × 1.0 route multiplier)
  - `/api/Data` (authenticated): 300 requests/5min (baseline × 2.0 × 0.5)
  - `/` (public): 600 requests/5min (baseline × 2.0 route multiplier)

## Security Flow (Updated)

```
1. Blocklist Check → 403 if blocked
2. Turnstile Check → 403 if invalid token
3. PRELIMINARY Rate Limit → 403 if exceeded (before routing)
4. Route Matching → 404 if no match
5. HMAC Verification → 403 if required and fails
6. REFINED Rate Limit → 429 (if authenticated) or 403 (if anonymous)
7. Origin Check → 403 if not allowed
8. Proxy Request → Forward to backend
```

## Testing

### Test Rate Limiting

```bash
# Test anonymous rate limit (will get 403 when exceeded)
for i in {1..350}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    https://your-worker.workers.dev/api/data
done

# Test authenticated rate limit (will get 429 with details when exceeded)
for i in {1..650}; do
  curl -s -w "%{http_code}\n" \
    -H "X-Auth-Token: YOUR_HMAC_TOKEN" \
    -H "X-Timestamp: $(date +%s)" \
    -H "X-Nonce: $(uuidgen)" \
    -H "X-Body-Hash: YOUR_BODY_HASH" \
    https://your-worker.workers.dev/api/data
done
```

### Test Wildcard Origins

```bash
# Should work now (matches *.aesysit.com)
curl -H "Origin: https://app.aesysit.com" \
  https://your-worker.workers.dev/api/data

# Should also work
curl -H "Origin: https://admin.aesysit.com" \
  https://your-worker.workers.dev/api/data
```

## Monitoring

Rate limit events are logged with structured JSON:

```json
{
  "timestamp": "2026-02-02T10:30:00.000Z",
  "method": "GET",
  "path": "/api/data",
  "status": 429,
  "auditType": "RATE_LIMIT_EXCEEDED",
  "clientIp": "203.0.113.42",
  "limit": 600,
  "current": 601,
  "retryAfter": 42,
  "authenticated": true,
  "routePrefix": "/api/data"
}
```

## Limitations (Per Option C Design)

- **Per-isolate limits:** Each Cloudflare edge location has independent counters
- **Cold start resets:** Limits reset when Worker isolate is evicted (typically after inactivity)
- **No global enforcement:** A client can hit different edge locations and get fresh limits
- **Memory-only:** No persistent ban lists (could be added with KV if needed)

## Next Steps (Optional)

1. **Deploy to production:** Update KV config with rate limit settings
2. **Monitor logs:** Watch for `RATE_LIMIT_EXCEEDED` events
3. **Tune limits:** Adjust `requestsPerWindow` based on legitimate traffic patterns
4. **Add persistent bans:** Use KV to store IPs that exceed limits multiple times (future enhancement)

## Rollback

To disable rate limiting:

```json
{
  "rateLimit": {
    "enabled": false
  }
}
```

Or simply omit the `rateLimit` field entirely.
