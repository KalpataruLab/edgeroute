import type { Context } from 'hono';
import { type Env, type Route, execCtx, forRoute, getConfig, getAuthSalt, getAuthKeys, getTurnstileSecret } from './config';
import { log, logSuccess, createLogEntry } from './logger';
import { verifyTurnstileToken } from './turnstile';
import { verifyStrongerHMAC } from './auth';
import { checkRateLimit } from './ratelimit';
import { isCallerBlocked, isOriginAllowed, hasEncodedTraversal } from './policy';
import { corsHeaders } from './cors';
import { recordMetric } from './metrics';
import { sharedDown } from './health';
import { replayClaimer } from './replay';
import { RETRY_STATUSES, pickTarget, recordResult, routeTargets } from './balancer';

export interface MatchedRoute {
  route: Route;
  remainingPath: string;
}

// Headers that are for this proxy only (or hop-by-hop) and must not reach the backend.
// Cookie / Authorization are deliberately forwarded: backends need them.
const STRIP_REQUEST_HEADERS = [
  'x-auth-token',
  'x-device-pub',
  'x-enroll-token',
  'x-key-id',
  'x-nonce',
  'x-timestamp',
  'x-body-hash',
  'x-turnstile-token',
  'x-admin-key',
  'x-real-ip',
  'origin',
  'referer',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
];

function isPrefixMatch(path: string, prefix: string): boolean {
  if (prefix.endsWith('/')) {
    return path.startsWith(prefix);
  }
  return path === prefix || path.startsWith(`${prefix}/`);
}

function joinPaths(basePath: string, suffix: string): string {
  const base = basePath === '/' ? '' : basePath;
  if (!suffix) {
    return base || '/';
  }
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  if (!base) {
    return normalizedSuffix;
  }
  return base.endsWith('/') ? `${base.slice(0, -1)}${normalizedSuffix}` : `${base}${normalizedSuffix}`;
}

export function findMatchingRoute(path: string, routes: Route[]): MatchedRoute | null {
  // First-match-wins: iterate in order
  for (const route of routes) {
    if (isPrefixMatch(path, route.prefix)) {
      // Extract remaining path after prefix
      const remainingPath = path.slice(route.prefix.length);
      return { route, remainingPath };
    }
  }
  return null;
}

/** Generic error body: details go to the logs, the caller only gets a request ID. */
function errorResponse(request: Request, status: number, error: string, requestId: string): Response {
  const headers = corsHeaders(request, null);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify({ error, requestId }), { status, headers });
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A request carrying any of these may get a per-caller response, so it never reads or fills the cache. */
const NO_CACHE_REQUEST_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-auth-token',
  'x-device-id',
  'x-device-pub',
  'x-key-id',
  'x-admin-key'
];
const MAX_CACHED_BYTES = 1024 * 1024;
/** Only cache bodies of known size under 1 MB, with no cookies, no Vary beyond Accept-Encoding and no private/no-store/zero-lifetime directive. */
function isCacheable(res: Response): boolean {
  const len = Number(res.headers.get('Content-Length'));
  if (!(len >= 0) || res.headers.get('Content-Length') === null || len > MAX_CACHED_BYTES) return false;
  if (res.headers.has('Set-Cookie')) return false;
  // Vary: only Accept-Encoding is safe (the Cache API handles it); anything else could mean per-caller content.
  const vary = (res.headers.get('Vary') ?? '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
  if (vary.some(v => v !== 'accept-encoding')) return false;
  // Tokenise leniently (commas, spaces, ';', spaces around '='): a stricter reading can only refuse more.
  for (const token of (res.headers.get('Cache-Control') ?? '')
    .toLowerCase()
    .replace(/\s*=\s*/g, '=')
    .split(/[\s,;]+/)) {
    const [name, value] = token.split('=', 2);
    if (name === 'private' || name === 'no-store' || name === 'no-cache') return false;
    if ((name === 'max-age' || name === 's-maxage') && !(Number(value?.replace(/"/g, '')) > 0)) return false;
  }
  return true;
}

export async function proxyRequest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const startTime = Date.now();
  const request = c.req.raw;
  const url = new URL(request.url);
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const incomingId = request.headers.get('X-Request-Id') ?? '';
  // Accept a caller's ID only if it is short and plain (it goes into logs and headers); else use cf-ray or a new UUID.
  const requestId = /^[A-Za-z0-9._-]{1,64}$/.test(incomingId) ? incomingId : request.headers.get('cf-ray') || crypto.randomUUID();
  const entryFor = (status: number, fields: Record<string, unknown> = {}) =>
    createLogEntry(request, status, Date.now() - startTime, { requestId, ...fields });

  /** Log one event and return the response to send. */
  const respond = (status: number, fields: Record<string, unknown>, response: Response): Response => {
    const entry = entryFor(status, fields);
    log(entry);
    recordMetric(c.env.METRICS, entry);
    response.headers.set('X-Request-Id', requestId);
    return response;
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  try {
    if (hasEncodedTraversal(url.pathname)) {
      return respond(
        400,
        { error: 'Encoded path traversal characters', auditType: 'PATH_REJECTED', clientIp },
        new Response('', { status: 400 })
      );
    }

    const config = await getConfig(c.env, execCtx(c));

    // Blocklist (explicit deny)
    if (isCallerBlocked(request, config)) {
      return respond(
        403,
        {
          error: 'Access blocked by policy',
          reason: request.headers.get('cf-worker') ? 'Blocked Worker' : 'Blocked Origin',
          origin: request.headers.get('Origin') || 'null',
          worker: request.headers.get('cf-worker') || 'null',
          auditType: 'BLOCKLIST_HIT'
        },
        new Response('Forbidden: Access blocked by policy', { status: 403 })
      );
    }

    const rateLimited = (check: ReturnType<typeof checkRateLimit>, authenticated: boolean, routePrefix?: string): Response => {
      const fields = {
        error: 'Rate limit exceeded',
        clientIp,
        limit: check.limit,
        current: check.current,
        retryAfter: check.retryAfter,
        routePrefix,
        auditType: 'RATE_LIMIT_EXCEEDED',
        authenticated
      };
      if (!authenticated) {
        // Anonymous: silent 403 (matches the HMAC failure pattern)
        return respond(403, fields, new Response('', { status: 403 }));
      }
      return respond(
        429,
        fields,
        json(
          429,
          {
            error: 'Too Many Requests',
            message: `Rate limit exceeded. Please retry after ${check.retryAfter} seconds.`,
            limit: check.limit,
            retryAfter: check.retryAfter
          },
          { 'Retry-After': String(check.retryAfter) }
        )
      );
    };

    // Cheap baseline rate-limit check first (a refined, per-route check runs after HMAC)
    if (config.rateLimit?.enabled && clientIp !== 'unknown') {
      const prelim = checkRateLimit(clientIp, config, undefined, false);
      if (!prelim.allowed) return rateLimited(prelim, false);
    }

    // Request limits for every route (opt-in): method allowlist, then declared body size.
    const limits = config.limits;
    if (limits?.allowedMethods) {
      const allowed = limits.allowedMethods.map(m => m.toUpperCase());
      if (!allowed.includes(request.method.toUpperCase())) {
        return respond(
          405,
          { error: 'Method not allowed', auditType: 'METHOD_REJECTED', clientIp },
          new Response('', { status: 405, headers: { Allow: allowed.join(', ') } })
        );
      }
    }
    if (limits?.maxBodyBytes !== undefined) {
      // Only the declared length can be checked without buffering; chunked bodies carry none.
      const declared = Number(request.headers.get('Content-Length'));
      if (declared > limits.maxBodyBytes) {
        return respond(
          413,
          { error: 'Declared body too large', declared, limit: limits.maxBodyBytes, auditType: 'BODY_TOO_LARGE', clientIp },
          new Response('', { status: 413 })
        );
      }
    }

    // Turnstile (after the cheap check, so junk requests don't each cost a siteverify call)
    const turnstileSecret = getTurnstileSecret(config, c.env);
    if (turnstileSecret) {
      const token = request.headers.get('X-Turnstile-Token');
      const ok = await verifyTurnstileToken(token || '', turnstileSecret, clientIp === 'unknown' ? undefined : clientIp);
      if (!ok) {
        return respond(
          403,
          { error: 'Turnstile verification failed', hasToken: !!token, auditType: 'TURNSTILE_FAILED' },
          json(403, {
            error: 'Forbidden',
            message: 'Turnstile verification failed. Please provide a valid X-Turnstile-Token header.'
          })
        );
      }
    }

    const match = findMatchingRoute(url.pathname, config.routes);
    if (!match) {
      return respond(404, { error: 'No matching route found' }, new Response('No matching route found', { status: 404 }));
    }
    const { route, remainingPath } = match;
    const routeConfig = forRoute(config, route); // per-route allowedOrigins, when set

    if (route.methods && !route.methods.some(m => m.toUpperCase() === request.method.toUpperCase())) {
      return respond(
        405,
        { error: 'Method not allowed', matchedPrefix: route.prefix, auditType: 'METHOD_REJECTED', clientIp },
        new Response('', { status: 405, headers: { Allow: route.methods.map(m => m.toUpperCase()).join(', ') } })
      );
    }

    // Route-level HMAC
    let isAuthenticated = false;
    let authFields: Record<string, unknown> = {}; // folded into the final log line instead of a line of its own
    if (route.hmacRequired) {
      const defaultSalt = getAuthSalt(config, c.env);
      const keys = getAuthKeys(c.env);
      // Key rotation: X-Key-Id picks one of the AUTH_KEYS secrets; without it the default AUTH_SALT is used.
      // The header only selects the secret: a wrong id means a wrong key, so the signature fails.
      const keyId = request.headers.get('X-Key-Id') ?? undefined;
      const authSalt = keyId === undefined ? defaultSalt : Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;
      if (!defaultSalt && !Object.keys(keys).length) {
        // Fail closed: never serve an HMAC route without a secret.
        return respond(
          503,
          {
            error: 'HMAC required but no secret configured',
            routePrefix: route.prefix,
            requestId,
            auditType: 'HMAC_MISCONFIGURED'
          },
          errorResponse(request, 503, 'Service Unavailable', requestId)
        );
      }

      if (!authSalt) {
        // Unknown key id, or no default key and no id sent. Bare status; the reason goes to the audit log only.
        return respond(
          403,
          {
            error: 'AUTH_FAIL: HMAC verification failed',
            reason: keyId === undefined ? 'Key id required' : 'Unknown key id',
            routePrefix: route.prefix,
            auditType: 'HMAC_VERIFICATION_FAILED',
            clientIp,
            keyId: keyId?.slice(0, 32)
          },
          new Response('', { status: 403 })
        );
      }

      const result = await verifyStrongerHMAC(
        request,
        authSalt,
        undefined,
        config.deviceKeys,
        config.strictReplay ? replayClaimer(c.env) : undefined
      );
      const statusCode = result.statusCode || 403;
      if (!result.valid) {
        // Detailed reason goes to the audit log only; the caller gets a bare status.
        return respond(
          statusCode,
          {
            error: 'AUTH_FAIL: HMAC verification failed',
            reason: result.reason,
            routePrefix: route.prefix,
            auditType: 'HMAC_VERIFICATION_FAILED',
            clientIp,
            deviceId: result.deviceId,
            keyId: keyId?.slice(0, 32),
            userAgent: request.headers.get('User-Agent') || 'unknown',
            hasToken: !!request.headers.get('X-Auth-Token'),
            hasTimestamp: !!request.headers.get('X-Timestamp'),
            hasNonce: !!request.headers.get('X-Nonce')
          },
          new Response('', { status: statusCode })
        );
      }

      isAuthenticated = true;
      authFields = { auditType: 'AUTH_SUCCESS', hmacVerified: true, clientIp, deviceId: result.deviceId, keyId };
    }

    // Refined rate limit (route multiplier, HMAC multiplier / bypass)
    if (config.rateLimit?.enabled && clientIp !== 'unknown') {
      const check = checkRateLimit(clientIp, config, route, isAuthenticated);
      if (!check.allowed) return rateLimited(check, isAuthenticated, route.prefix);
    }

    // Origin allowlist
    const origin = request.headers.get('Origin');
    // A WebSocket handshake must match an allowed origin exactly (scheme, host and port), not just the hostname.
    const wsUpgrade = route.websocket === true && request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    if (!isOriginAllowed(origin, routeConfig) || (wsUpgrade && origin && !routeConfig.allowedOrigins?.includes(origin))) {
      return respond(
        403,
        { error: 'Origin not allowed', origin: origin || 'null', auditType: 'ORIGIN_BLOCKED' },
        new Response('Forbidden: Origin not allowed', { status: 403 })
      );
    }

    // Edge cache (GET only): keyed by the client URL, never for callers that send credentials.
    const cache =
      route.cacheTtl && request.method === 'GET' && !NO_CACHE_REQUEST_HEADERS.some(h => request.headers.has(h))
        ? (globalThis as { caches?: { default?: Cache } }).caches?.default
        : undefined;
    const cacheKey = new Request(url.toString());
    const withCors = (src: Response, extra?: Record<string, string>) => {
      const h = new Headers(src.headers);
      h.delete('Access-Control-Allow-Origin');
      h.delete('Access-Control-Allow-Credentials');
      for (const [k, v] of corsHeaders(request, routeConfig)) {
        if (k.toLowerCase() === 'vary') h.append(k, v);
        else h.set(k, v);
      }
      for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
      h.set('X-Request-Id', requestId); // ours, never the backend's or a cached copy's
      return new Response(src.body, { status: src.status, statusText: src.statusText, headers: h });
    };
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const entry = entryFor(hit.status, { matchedPrefix: route.prefix, auditType: 'CACHE_HIT' });
        logSuccess(entry, c.env);
        recordMetric(c.env.METRICS, entry);
        return withCors(hit, { 'X-Cache': 'HIT' });
      }
    }

    const parsedTimeout = parseInt(c.env.REQUEST_TIMEOUT || '120000', 10);
    const timeout = route.timeoutMs ?? (parsedTimeout > 0 ? parsedTimeout : 120000);

    const headers = new Headers(request.headers);
    for (const name of STRIP_REQUEST_HEADERS) headers.delete(name);
    // Overwrite (never append to) the client-supplied value: it is spoofable.
    if (clientIp !== 'unknown') {
      headers.set('X-Forwarded-For', clientIp);
    } else {
      headers.delete('X-Forwarded-For');
    }
    headers.set('X-Forwarded-Proto', url.protocol.slice(0, -1));
    headers.set('X-Request-Id', requestId);
    // Backend lock-down: drop any client copy of the secret header, then (after route headers, so they
    // cannot override it) add the real one. Backends that check it refuse traffic that skipped the proxy.
    const lockName = /^[A-Za-z0-9-]+$/.test(c.env.BACKEND_SECRET_HEADER ?? '') ? c.env.BACKEND_SECRET_HEADER! : 'X-Proxy-Secret';
    headers.delete(lockName);
    for (const [k, v] of Object.entries(route.headers ?? {})) headers.set(k, v);
    if (c.env.BACKEND_SECRET) headers.set(lockName, c.env.BACKEND_SECRET);
    // WebSocket: only on routes that opt in. The generic strip above removed Upgrade, so put it back.
    if (wsUpgrade) {
      headers.set('Upgrade', 'websocket');
      if (origin) headers.set('Origin', origin); // let the backend check it too
    }

    // Failover only for bodyless safe methods: a streamed request body cannot be replayed.
    const targets = routeTargets(route);
    const maxAttempts = request.method === 'GET' || request.method === 'HEAD' ? Math.min(2, targets.length) : 1;
    const tried = new Set<string>();
    const down = route.healthCheck && targets.length > 1 ? await sharedDown(c.env) : undefined;

    for (let attempt = 1; ; attempt++) {
      const target = pickTarget(targets, tried, route.prefix, Date.now(), Math.random, down) ?? targets[0]!; // routeTargets never returns an empty list
      tried.add(target.url);
      // Target URL: target + remaining path + query. Only origin+path is ever logged.
      const targetUrl = new URL(target.url);
      targetUrl.pathname = joinPaths(targetUrl.pathname, route.stripPrefix === false ? url.pathname : remainingPath);
      targetUrl.search = url.search;
      const loggedTarget = targetUrl.origin + targetUrl.pathname;
      headers.set('Host', targetUrl.host);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      const last = attempt >= maxAttempts;
      try {
        const proxyResponse = await fetch(targetUrl.toString(), {
          method: request.method,
          headers,
          body: request.body,
          redirect: 'manual',
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        const unhealthy = RETRY_STATUSES.has(proxyResponse.status);
        recordResult(route.prefix, target.url, !unhealthy);
        if (unhealthy && !last) {
          log(
            entryFor(proxyResponse.status, {
              matchedPrefix: route.prefix,
              targetUrl: loggedTarget,
              auditType: 'FAILOVER',
              attempt
            })
          );
          void proxyResponse.body?.cancel();
          continue;
        }

        const entry = entryFor(proxyResponse.status, {
          matchedPrefix: route.prefix,
          targetUrl: loggedTarget,
          ...authFields,
          ...(attempt > 1 ? { attempt } : {})
        });
        logSuccess(entry, c.env);
        recordMetric(c.env.METRICS, entry);

        // Store a copy: 200 only, small known size, nothing private or per-user.
        if (cache && proxyResponse.status === 200 && isCacheable(proxyResponse)) {
          const stored = new Response(proxyResponse.clone().body, { status: 200, headers: proxyResponse.headers });
          stored.headers.set('Cache-Control', `public, max-age=${route.cacheTtl}`);
          const put = cache.put(cacheKey, stored).catch(() => {});
          let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
          try {
            ctx = c.executionCtx;
          } catch {
            /* no execution context (tests) */
          }
          if (ctx) ctx.waitUntil(put);
          else await put;
        }

        // A 101 carries the socket in `webSocket`; rebuilding the Response would drop it, so hand it back as is.
        if (proxyResponse.status === 101) return proxyResponse;

        // Our CORS policy replaces whatever the backend sent.
        return withCors(proxyResponse);
      } catch (error: unknown) {
        clearTimeout(timeoutId);
        recordResult(route.prefix, target.url, false);
        const timedOut = error instanceof Error && error.name === 'AbortError';
        if (!last) {
          log(
            entryFor(timedOut ? 504 : 503, {
              matchedPrefix: route.prefix,
              targetUrl: loggedTarget,
              auditType: 'FAILOVER',
              attempt,
              error: timedOut ? 'Request timeout' : errMessage(error)
            })
          );
          continue;
        }
        const status = timedOut ? 504 : 503;
        return respond(
          status,
          {
            matchedPrefix: route.prefix,
            targetUrl: loggedTarget,
            ...(timedOut ? { timeout: true, error: 'Request timeout' } : { error: errMessage(error) }),
            requestId
          },
          errorResponse(request, status, timedOut ? 'Gateway Timeout' : 'Service Unavailable', requestId)
        );
      }
    }
  } catch (error: unknown) {
    return respond(
      500,
      {
        error: errMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
        requestId
      },
      errorResponse(request, 500, 'Internal Server Error', requestId)
    );
  }
}
