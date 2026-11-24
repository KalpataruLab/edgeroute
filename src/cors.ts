import type { ProxyConfig } from './config';
import { isOriginAllowed } from './policy';

const DEFAULT_ALLOW_HEADERS =
  'Content-Type, Authorization, X-Auth-Token, X-Timestamp, X-Nonce, X-Body-Hash, X-Device-Id, X-Device-Pub, X-Enroll-Token, X-Key-Id, X-Turnstile-Token';

/**
 * Single place that decides CORS headers (preflight, proxied responses, errors).
 * - allowedOrigins empty/missing: allow any origin ("*").
 * - allowedOrigins set: echo the origin only if it is allowed; otherwise send no
 *   Access-Control-Allow-Origin at all (the browser then blocks the call).
 * `config` may be null when it could not be loaded (generic error responses).
 */
export function corsHeaders(request: Request, config: ProxyConfig | null, preflight = false): Headers {
  const h = new Headers();
  const origin = request.headers.get('Origin');

  if (config?.allowedOrigins?.length) {
    h.append('Vary', 'Origin');
    if (origin && isOriginAllowed(origin, config)) {
      h.set('Access-Control-Allow-Origin', origin);
    }
  } else {
    h.set('Access-Control-Allow-Origin', '*');
  }

  if (preflight) {
    h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    h.set('Access-Control-Allow-Headers', request.headers.get('Access-Control-Request-Headers') || DEFAULT_ALLOW_HEADERS);
    h.set('Access-Control-Max-Age', '86400');
  } else {
    h.set('Access-Control-Expose-Headers', '*');
  }
  return h;
}
