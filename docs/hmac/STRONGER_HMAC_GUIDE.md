# Stronger HMAC Implementation Guide

This branch implements a more secure HMAC verification system with:
- **HMAC-SHA256** (proper keyed hash, not simple SHA)
- **Message includes**: timestamp + method + path + bodyHash + userAgent + nonce
- **One-time nonce** remembered in Worker memory (per instance, no KV) to limit replay attacks
- **Short expiry**: 30 seconds (configurable)

## Security Rating: 6.5/10

Still vulnerable because the secret is in frontend code, but significantly harder to abuse than simple SHA(timestamp+salt).

---

## Backend Configuration

Update `config.json`:
```json
{
  "authSalt": "your-long-random-secret-string-here"
}
```

The worker will automatically use the stronger HMAC verification if `authSalt` is present.

---

## Frontend Implementation (Angular)

### Step 1: Install Crypto (Built-in)
Modern browsers have `crypto.subtle` API. No extra packages needed.

### Step 2: Create Auth Service

```typescript
// auth.service.ts
import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly SECRET = 'your-long-random-secret-string-here'; // MUST match backend

  /**
   * Generate HMAC-SHA256
   */
  private async generateHMAC(secret: string, message: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(message);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const hashArray = Array.from(new Uint8Array(signature));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Hash request body
   */
  private async hashBody(body: any): Promise<string> {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const encoder = new TextEncoder();
    const data = encoder.encode(bodyStr);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Generate random nonce (UUID-like)
   */
  private generateNonce(): string {
    return crypto.randomUUID();
  }

  /**
   * Generate authentication headers for a request
   */
  async generateAuthHeaders(
    method: string,
    url: string,
    body?: any
  ): Promise<Record<string, string>> {
    const urlObj = new URL(url);
    const path = urlObj.pathname + urlObj.search;
    const timestamp = Date.now().toString();
    const nonce = this.generateNonce();
    const userAgent = navigator.userAgent;

    // Hash body if present
    const bodyHash = body ? await this.hashBody(body) : '';

    // Build message: timestamp|method|path|bodyHash|userAgent|nonce
    const message = `${timestamp}|${method.toUpperCase()}|${path}|${bodyHash}|${userAgent}|${nonce}`;

    // Generate HMAC
    const token = await this.generateHMAC(this.SECRET, message);

    return {
      'X-Auth-Token': token,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Body-Hash': bodyHash
    };
  }
}
```

### Step 3: Use in HTTP Interceptor

```typescript
// auth.interceptor.ts
import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent } from '@angular/common/http';
import { Observable, from, switchMap } from 'rxjs';
import { AuthService } from './auth.service';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(private authService: AuthService) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // Only add auth headers for API requests
    if (req.url.includes('your-worker.workers.dev')) {
      return from(this.authService.generateAuthHeaders(req.method, req.url, req.body)).pipe(
        switchMap(authHeaders => {
          const cloned = req.clone({ setHeaders: authHeaders });
          return next.handle(cloned);
        })
      );
    }

    return next.handle(req);
  }
}
```

### Step 4: Register Interceptor

```typescript
// app.module.ts or app.config.ts
import { HTTP_INTERCEPTORS } from '@angular/common/http';
import { AuthInterceptor } from './auth.interceptor';

providers: [
  { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true }
]
```

---

## How It Works

```
Angular App
  ├─ Generate nonce (random UUID)
  ├─ Get timestamp (Date.now())
  ├─ Hash body (if POST/PUT)
  ├─ Build message: ts|method|path|bodyHash|UA|nonce
  ├─ Calculate: HMAC-SHA256(secret, message)
  ├─ Send headers:
  │    X-Auth-Token: <hmac>
  │    X-Timestamp: <ts>
  │    X-Nonce: <nonce>
  │    X-Body-Hash: <bodyHash>
  ▼
Cloudflare Worker
  ├─ Check timestamp (within 30s?)
  ├─ Check nonce in memory (already used?)
  ├─ Rebuild message from headers
  ├─ Recalculate HMAC
  ├─ Compare (match?)
  ├─ Keep nonce in memory (expiry: 60s)
  ▼
Allow or Deny
```

---

## Security Benefits

1. **Replay Protection**: Each nonce can only be used once (remembered in memory per Worker instance).
2. **Expiry**: Tokens expire after 30 seconds.
3. **Integrity**: Body hash prevents request tampering.
4. **Binding**: UserAgent makes it harder to use stolen tokens from different devices.

---

## Limitations

⚠️ **The secret is still in the frontend bundle**, so a determined attacker can:
1. Inspect the Angular bundle.
2. Extract the secret.
3. Write a script to generate valid tokens.

However, this approach **raises the bar significantly** and stops:
- Casual copy-paste attacks
- Simple replay attacks
- Non-technical attackers

For full security, you still need **Turnstile** or **BFF/JWT** as discussed.

---

## Testing

### Test with curl (simulating Angular):

```bash
SECRET="your-long-random-secret-string-here"
TIMESTAMP=$(date +%s000)
NONCE=$(uuidgen)
METHOD="GET"
PATH="/api/data"
BODY_HASH=""
USER_AGENT="curl/7.68.0"

# Build message
MESSAGE="${TIMESTAMP}|${METHOD}|${PATH}|${BODY_HASH}|${USER_AGENT}|${NONCE}"

# Generate HMAC (requires openssl or node)
TOKEN=$(echo -n "$MESSAGE" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

# Make request
curl -H "X-Auth-Token: $TOKEN" \
     -H "X-Timestamp: $TIMESTAMP" \
     -H "X-Nonce: $NONCE" \
     -H "X-Body-Hash: $BODY_HASH" \
     https://your-worker.workers.dev/api/data
```

---

## Deployment

1. Update `config.json` with your secret.
2. Deploy: `pnpm run deploy`
3. Upload config: `wrangler kv:key put --namespace-id=YOUR_ID "config" --path=config.json`
4. Update Angular frontend with the code above.

## Optional device ID (audit trail)

Clients may send `X-Device-Id` (8-64 characters: letters, digits, `.`, `_`, `-`; use a random value stored on the device). When present:

- it is appended to the signed message: `timestamp|METHOD|path|bodyHash|User-Agent|nonce|deviceId`. When absent the message is unchanged, so existing clients keep working;
- a malformed value is rejected with 400;
- it is logged as `deviceId` on `AUTH_SUCCESS` and `HMAC_VERIFICATION_FAILED` entries, and forwarded to the backend.

This is **not authentication**: all clients share one secret, so anyone holding it can claim any ID. Use it to spot anomalies (one device ID from many IPs or user agents, bursts of failures). Per-device keys and revocation are on `docs/ROADMAP.md`.
