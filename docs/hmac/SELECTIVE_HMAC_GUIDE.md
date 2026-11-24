# Selective HMAC Verification Guide

## Overview

Instead of requiring HMAC verification for ALL requests, you can now configure **specific paths or path groups** that require HMAC authentication. Other paths will bypass HMAC checks entirely.

---

## Configuration

Add `hmacRequiredPaths` to your `config.json`:

```json
{
  "routes": [...],
  "hmacRequiredPaths": [
    "/api/admin/*",
    "/api/data/sensitive",
    "/api/payment/*",
    "/api/users/delete"
  ],
  "authSalt": "your-secret-here",
  "version": "1.0"
}
```

### Pattern Matching

- **Exact match**: `/api/users/delete` → Only matches exactly `/api/users/delete`
- **Wildcard**: `/api/admin/*` → Matches `/api/admin/users`, `/api/admin/settings/profile`, etc.
- **Query params**: `/api/data?page=1` → Matches if `/api/data` is in the list

---

## How It Works

```
Request to /api/public/data
  ├─ Check: Is path in hmacRequiredPaths?
  │   └─ No → Skip HMAC, log "HMAC_BYPASSED"
  ▼
Proxy request (no HMAC required)

────────────────────────────────────

Request to /api/admin/users
  ├─ Check: Is path in hmacRequiredPaths?
  │   └─ Yes → Verify HMAC
  ├─ HMAC valid?
  │   ├─ Yes → Proxy request, log "HMAC_VERIFICATION_SUCCESS"
  │   └─ No → Block 403, log "HMAC_VERIFICATION_FAILED" with audit details
  ▼
```

---

## Audit Logs

All HMAC-related events are logged with `auditType` for easy filtering:

### Successful HMAC Verification
```json
{
  "auditType": "HMAC_VERIFICATION_SUCCESS",
  "path": "/api/admin/users",
  "hmacVerified": true,
  "timestamp": "2026-02-01T20:00:00.000Z"
}
```

### Failed HMAC Verification (Security Alert!)
```json
{
  "auditType": "HMAC_VERIFICATION_FAILED",
  "error": "HMAC verification failed",
  "reason": "Invalid HMAC signature",
  "path": "/api/admin/users",
  "requiredHMAC": true,
  "clientIp": "203.0.113.45",
  "userAgent": "Mozilla/5.0...",
  "status": 403,
  "timestamp": "2026-02-01T20:00:00.000Z"
}
```

### HMAC Bypassed (Path Not Protected)
```json
{
  "auditType": "HMAC_BYPASSED",
  "path": "/api/public/data",
  "hmacBypassed": true,
  "reason": "Path not in hmacRequiredPaths",
  "timestamp": "2026-02-01T20:00:00.000Z"
}
```

---

## Example Use Cases

### 1. Protect Admin Endpoints Only
```json
{
  "hmacRequiredPaths": [
    "/api/admin/*"
  ]
}
```
- `/api/admin/users` → Requires HMAC ✅
- `/api/public/data` → No HMAC ❌

### 2. Protect Sensitive Data Operations
```json
{
  "hmacRequiredPaths": [
    "/api/users/delete",
    "/api/users/update",
    "/api/payment/*"
  ]
}
```
- `/api/users/delete` → Requires HMAC ✅
- `/api/users/list` → No HMAC ❌
- `/api/payment/checkout` → Requires HMAC ✅

### 3. Protect Entire API Except Public Endpoints
```json
{
  "hmacRequiredPaths": [
    "/api/*"
  ],
  "allowedOrigins": [],
  "blockedOrigins": []
}
```
Then manually exclude by not adding public paths to the list.

---

## Monitoring & Alerts

### Query Logs for Failed HMAC Attempts

Using Cloudflare Logs / Logpush:
```sql
SELECT 
  timestamp,
  path,
  clientIp,
  userAgent,
  reason
FROM logs
WHERE auditType = 'HMAC_VERIFICATION_FAILED'
ORDER BY timestamp DESC
LIMIT 100
```

### Using `wrangler tail`:
```bash
wrangler tail --format=pretty | grep "HMAC_VERIFICATION_FAILED"
```

---

## Security Best Practices

1. **Start Broad, Then Narrow**: 
   - Initially protect all sensitive paths (`/api/admin/*`, `/api/payment/*`)
   - Monitor logs for false positives
   - Adjust as needed

2. **Don't Protect Public Endpoints**:
   - Health checks: `/health`
   - Public data: `/api/public/*`
   - Static assets: `/assets/*`

3. **Regularly Review Audit Logs**:
   - Set up alerts for repeated `HMAC_VERIFICATION_FAILED` from same IP
   - Investigate unusual patterns

4. **Combine with Other Layers**:
   - Still use `allowedOrigins` for browser protection
   - Still use `blockedOrigins` for known attackers
   - HMAC is an additional layer for critical paths

---

## Deployment

1. Update `config.json`:
   ```json
   {
     "hmacRequiredPaths": ["/api/admin/*", "/api/payment/*"],
     "authSalt": "your-secret"
   }
   ```

2. Deploy worker:
   ```bash
   pnpm run deploy
   ```

3. Upload config:
   ```bash
   wrangler kv:key put --namespace-id=YOUR_ID "config" --path=config.json
   ```

4. Test protected path:
   ```bash
   # Should fail without HMAC
   curl https://your-worker.dev/api/admin/users
   # → 403 Forbidden
   
   # Should work with valid HMAC
   curl -H "X-Auth-Token: ..." -H "X-Timestamp: ..." \
        https://your-worker.dev/api/admin/users
   # → 200 OK
   ```

5. Test unprotected path:
   ```bash
   # Should work without HMAC
   curl https://your-worker.dev/api/public/data
   # → 200 OK
   ```

---

## Troubleshooting

### All Requests Being Blocked
- Check: Is `hmacRequiredPaths` accidentally set to `["/*"]`?
- Check: Is `authSalt` configured correctly?

### Protected Path Not Working
- Verify path pattern matches exactly
- Check logs: `auditType: "HMAC_BYPASSED"` means path didn't match

### HMAC Working But Still Getting 403
- Check other security layers (blocklist, origin allowlist)
- Look for `auditType` in logs to identify which check failed

---

## Migration from Full HMAC

If you previously had HMAC enabled for ALL paths:

**Before:**
```json
{
  "authSalt": "secret"
}
```
All paths required HMAC ✅

**After (Selective):**
```json
{
  "authSalt": "secret",
  "hmacRequiredPaths": ["/api/admin/*"]
}
```
Only `/api/admin/*` requires HMAC ✅  
Other paths bypass HMAC ❌

---

## Example Config

See `config.example.json` for a complete configuration template.

---

**Last Updated:** 2026-02-01
