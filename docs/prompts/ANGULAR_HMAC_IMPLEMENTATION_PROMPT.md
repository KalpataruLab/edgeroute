# Angular HMAC Authentication Implementation - Copy-Paste Prompt

Use this complete prompt to implement HMAC authentication in your Angular project. Copy everything below and paste to an AI assistant.

---

## Implementation Request

I need to implement HMAC-SHA256 request authentication in my Angular application to communicate with a backend API that requires the following authentication headers:

- `X-Auth-Token`: HMAC-SHA256 signature (hex encoded)
- `X-Timestamp`: Unix timestamp in milliseconds
- `X-Nonce`: Random UUID
- `X-Body-Hash`: SHA-256 hash of request body (hex encoded, empty string if no body)
- `X-Device-Id` (optional): random per-install ID, 8-64 characters of `[A-Za-z0-9._-]`, used only for the proxy's audit logs

### Authentication Flow

**Message Construction:**
```
message = timestamp|method|path|bodyHash|userAgent|nonce
message = timestamp|method|path|bodyHash|userAgent|nonce|deviceId    (when X-Device-Id is sent)
```

Device ID rules: generate it once (`crypto.randomUUID()`), keep it in `localStorage` (fall back to memory if storage is blocked), send the same value on every request and sign it every time. A header sent but not signed returns 403; a malformed value returns 400. It is an audit label, not authentication. The nonce must not contain `|` (a UUID is fine).

**HMAC Calculation:**
```
token = HMAC-SHA256(secret, message)
```

### Requirements

1. **Auth Service** that generates authentication headers
2. **HTTP Interceptor** that automatically attaches headers to API requests
3. **Error Handling** for authentication failures (400/401/403)
4. **Configuration** for API base URL and secret

---

## Step-by-Step Implementation

### Step 1: Create Auth Service

Create `src/app/services/auth.service.ts`:

```typescript
import { Injectable } from '@angular/core';
import { environment } from '../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly SECRET = environment.hmacSecret;
  private readonly API_BASE_URL = environment.apiBaseUrl;

  /**
   * Generate HMAC-SHA256 signature
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
   * Hash request body with SHA-256
   */
  private async hashBody(body: any): Promise<string> {
    if (!body) return '';
    
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const encoder = new TextEncoder();
    const data = encoder.encode(bodyStr);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Generate random nonce (UUID v4)
   */
  private generateNonce(): string {
    return crypto.randomUUID();
  }

  private memoryDeviceId?: string;

  /**
   * Stable random device ID for audit logs (not a secret, not authentication).
   * Returns undefined to disable the feature (do not send the header).
   */
  private getDeviceId(): string | undefined {
    try {
      let id = localStorage.getItem('deviceId');
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('deviceId', id);
      }
      return id;
    } catch {
      // Storage blocked (for example Safari private mode): keep one per page load
      return (this.memoryDeviceId ??= crypto.randomUUID());
    }
  }

  /**
   * Generate authentication headers for a request
   * @param method HTTP method (GET, POST, etc.)
   * @param url Full URL including query parameters
   * @param body Request body (optional)
   * @returns Object with authentication headers
   */
  async generateAuthHeaders(
    method: string,
    url: string,
    body?: any
  ): Promise<Record<string, string>> {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname + urlObj.search;
      const timestamp = Date.now().toString();
      const nonce = this.generateNonce();
      const userAgent = navigator.userAgent;

      // Hash body if present (for POST/PUT/PATCH)
      const bodyHash = await this.hashBody(body);

      // Optional device ID (audit trail only): signed when sent
      const deviceId = this.getDeviceId();

      // Build message: timestamp|method|path|bodyHash|userAgent|nonce[|deviceId]
      const message = `${timestamp}|${method.toUpperCase()}|${path}|${bodyHash}|${userAgent}|${nonce}` +
        (deviceId ? `|${deviceId}` : '');

      // Generate HMAC signature
      const token = await this.generateHMAC(this.SECRET, message);

      return {
        'X-Auth-Token': token,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Body-Hash': bodyHash,
        ...(deviceId ? { 'X-Device-Id': deviceId } : {})
      };
    } catch (error) {
      console.error('Failed to generate auth headers:', error);
      throw new Error('Authentication header generation failed');
    }
  }

  /**
   * Check if URL requires authentication
   */
  shouldAuthenticate(url: string): boolean {
    return url.startsWith(this.API_BASE_URL);
  }
}
```

### Step 2: Create HTTP Interceptor

Create `src/app/interceptors/auth.interceptor.ts`:

```typescript
import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Observable, from, throwError } from 'rxjs';
import { switchMap, catchError } from 'rxjs/operators';
import { AuthService } from '../services/auth.service';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(private authService: AuthService) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // Only add auth headers for API requests
    if (!this.authService.shouldAuthenticate(req.url)) {
      return next.handle(req);
    }

    // Generate auth headers asynchronously
    return from(this.authService.generateAuthHeaders(req.method, req.url, req.body)).pipe(
      switchMap(authHeaders => {
        // Clone request and add auth headers
        const cloned = req.clone({ 
          setHeaders: authHeaders 
        });
        return next.handle(cloned);
      }),
      catchError((error: HttpErrorResponse) => {
        // Handle authentication errors
        if (error.status === 400) {
          console.error('AUTH: Bad request - invalid headers');
        } else if (error.status === 401) {
          console.error('AUTH: Unauthorized - token expired or replay attack');
        } else if (error.status === 403) {
          console.error('AUTH: Forbidden - invalid signature');
        }
        return throwError(() => error);
      })
    );
  }
}
```

### Step 3: Register Interceptor

**For Angular 14+ (Standalone):**

In `src/app/app.config.ts`:

```typescript
import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { authInterceptorFn } from './interceptors/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptorFn]))
  ]
};
```

**For Angular < 14 (Module-based):**

In `src/app/app.module.ts`:

```typescript
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule, HTTP_INTERCEPTORS } from '@angular/common/http';
import { AuthInterceptor } from './interceptors/auth.interceptor';

@NgModule({
  declarations: [AppComponent],
  imports: [
    BrowserModule,
    HttpClientModule
  ],
  providers: [
    { 
      provide: HTTP_INTERCEPTORS, 
      useClass: AuthInterceptor, 
      multi: true 
    }
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
```

### Step 4: Environment Configuration

**`src/environments/environment.ts`** (Development):

```typescript
export const environment = {
  production: false,
  apiBaseUrl: 'http://localhost:8787',  // Your API base URL
  hmacSecret: 'your-development-secret-key-here'
};
```

**`src/environments/environment.prod.ts`** (Production):

```typescript
export const environment = {
  production: true,
  apiBaseUrl: 'https://api.yourproject.com',
  hmacSecret: 'your-production-secret-key-here-must-match-backend'
};
```

**⚠️ Important:** The `hmacSecret` must match exactly with your backend configuration.

### Step 5: Usage in Components

```typescript
import { Component } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-example',
  template: `<button (click)="fetchData()">Fetch Data</button>`
})
export class ExampleComponent {
  constructor(private http: HttpClient) {}

  fetchData() {
    // Interceptor automatically adds authentication headers
    this.http.get(`${environment.apiBaseUrl}/api/data`)
      .subscribe({
        next: (data) => console.log('Success:', data),
        error: (error) => {
          if (error.status === 400) {
            console.error('Bad request - check headers');
          } else if (error.status === 401) {
            console.error('Unauthorized - token expired');
          } else if (error.status === 403) {
            console.error('Forbidden - invalid signature');
          }
        }
      });
  }

  postData() {
    const payload = { id: 123, name: 'Test' };
    
    // Interceptor handles body hash automatically
    this.http.post(`${environment.apiBaseUrl}/api/data`, payload)
      .subscribe({
        next: (response) => console.log('Created:', response),
        error: (error) => console.error('Error:', error)
      });
  }
}
```

---

## Testing

### Test 1: Valid Request
```typescript
this.http.get('https://your-api.com/api/data').subscribe(
  data => console.log('✓ Authenticated successfully', data)
);
```

Expected: 200 OK with data

### Test 2: Check Network Tab
Open browser DevTools > Network tab and verify headers:
- `X-Auth-Token`: 64-character hex string
- `X-Timestamp`: Unix timestamp (13 digits)
- `X-Nonce`: UUID format
- `X-Body-Hash`: 64-character hex or empty

### Test 3: Backend Validation
Backend should log:
- Success: `AUTH_SUCCESS`
- Failure: `AUTH_FAIL: HMAC verification failed` (with details in server logs)

---

## Error Handling

The backend returns only status codes (silent failures) for security:

| Status | Meaning | Server Log (audit trail) |
|--------|---------|--------------------------|
| 400 | Missing headers or invalid format | `AUTH_FAIL: Missing required headers` |
| 401 | Expired token or replay attack | `AUTH_FAIL: Token expired` or `Nonce already used` |
| 403 | Invalid signature | `AUTH_FAIL: Invalid HMAC signature` |

**Client receives**: Empty response with status code only  
**Server logs**: Detailed error information for debugging

---

## Security Considerations

### ⚠️ Limitations

1. **Secret in frontend code**: The HMAC secret is visible in compiled JavaScript
   - Anyone can inspect the bundle and extract it
   - This provides moderate protection, not enterprise-grade security

2. **Not suitable for**:
   - Financial transactions
   - Sensitive user data (PII)
   - Admin operations
   - High-value targets

3. **Good enough for**:
   - Public APIs with rate limiting
   - Bot prevention (casual attackers)
   - Internal tools with low attack surface

### ✅ What This Prevents

- ✓ Replay attacks (nonce tracking)
- ✓ Request tampering (body hash)
- ✓ Expired tokens (30s window)
- ✓ Cross-device token theft (user-agent binding)
- ✓ Casual copy-paste attacks

### 🔒 For Better Security

Consider adding:
1. **Cloudflare Turnstile** - CAPTCHA alternative for bot detection
2. **OAuth 2.0 / JWT** - Proper user authentication
3. **Backend-for-Frontend (BFF)** - Hide secrets on server
4. **Rate Limiting** - Per IP/user limits
5. **Certificate Pinning** - For mobile apps

---

## Troubleshooting

### Issue: 403 Forbidden

**Cause**: HMAC signature mismatch

**Check**:
1. Secret matches backend exactly (case-sensitive)
2. Message format is correct: `timestamp|method|path|bodyHash|userAgent|nonce`
3. Body hash calculated correctly (JSON.stringify for objects)
4. No extra headers interfering

### Issue: 401 Unauthorized

**Cause**: Token expired or nonce reused

**Check**:
1. System clock synchronized (client/server time difference < 30s)
2. Not reusing nonces (each request needs unique UUID)
3. Request completes within 30-second window

### Issue: 400 Bad Request

**Cause**: Missing or malformed headers

**Check**:
1. All four headers present: `X-Auth-Token`, `X-Timestamp`, `X-Nonce`, `X-Body-Hash`
   (and, if `X-Device-Id` is sent, it is 8-64 characters of `[A-Za-z0-9._-]` and is also in the signed message)
2. Timestamp is valid number
3. Interceptor is registered properly

### Debug Logging

Add to `auth.service.ts`:

```typescript
console.log('HMAC Debug:', {
  method,
  path,
  timestamp,
  nonce,
  bodyHash,
  message,
  token
});
```

---

## Deployment Checklist

- [ ] Update `environment.prod.ts` with production API URL
- [ ] Update `environment.prod.ts` with production HMAC secret (matches backend)
- [ ] Test with backend in staging environment
- [ ] Verify clock synchronization between client/server
- [ ] Monitor authentication failure rates
- [ ] Set up alerts for high 401/403 rates
- [ ] Document secret rotation procedure
- [ ] Add error tracking (Sentry, LogRocket, etc.)

---

## Advanced: Functional Interceptor (Angular 15+)

For newer Angular versions using functional interceptors:

```typescript
// src/app/interceptors/auth.interceptor.ts
import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, throwError } from 'rxjs';
import { switchMap, catchError } from 'rxjs/operators';
import { AuthService } from '../services/auth.service';

export const authInterceptorFn: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);

  if (!authService.shouldAuthenticate(req.url)) {
    return next(req);
  }

  return from(authService.generateAuthHeaders(req.method, req.url, req.body)).pipe(
    switchMap(authHeaders => {
      const cloned = req.clone({ setHeaders: authHeaders });
      return next(cloned);
    }),
    catchError((error: HttpErrorResponse) => {
      if ([400, 401, 403].includes(error.status)) {
        console.error(`AUTH_ERROR: ${error.status} - Check server logs for details`);
      }
      return throwError(() => error);
    })
  );
};
```

---

## Summary

After implementation, your Angular app will:
1. ✅ Automatically generate HMAC signatures for all API requests
2. ✅ Include timestamp, nonce, and body hash in headers
3. ✅ Handle authentication failures gracefully
4. ✅ Prevent replay attacks through one-time nonces
5. ✅ Verify request integrity via body hashing

The backend will receive silent failures (status codes only) while logging detailed error information for audit trails.
