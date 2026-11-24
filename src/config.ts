// Configuration types and interfaces

export interface Route {
  prefix: string;
  target: string; // single backend, or the first of `targets` (filled in by validateConfig)
  targets?: Array<string | { url: string; weight?: number }>; // several backends: weighted pick, failover for GET/HEAD
  cacheTtl?: number; // Optional: edge-cache successful GET responses for this many seconds (not allowed with hmacRequired)
  timeoutMs?: number; // Optional: backend timeout for this route (default: REQUEST_TIMEOUT)
  methods?: string[]; // Optional: only these methods on this route; others get 405
  stripPrefix?: boolean; // Optional: false keeps the matched prefix in the backend path (default: true, strip it)
  headers?: Record<string, string>; // Optional: headers set on the backend request (override the client's)
  allowedOrigins?: string[]; // Optional: CORS/origin allowlist for this route, replacing the global one
  healthCheck?: { path: string; timeoutMs?: number }; // Optional: the Cron Trigger probes each target with GET <path>; failing targets are skipped
  websocket?: boolean; // Optional: pass WebSocket upgrades on this route through to the backend (default: false)
  hmacRequired?: boolean; // Optional: Require HMAC verification for this route (default: false)
  rateLimitMultiplier?: number; // Optional: Multiplier for rate limit (default: 1.0, e.g., 0.5 = half rate, 2.0 = double rate)
}

export interface ProxyConfig {
  routes: Route[];
  allowedOrigins?: string[]; // Optional whitelist of allowed origins
  blockedOrigins?: string[]; // Optional blacklist of blocked origins/hostnames
  turnstileSecretKey?: string; // Optional: Cloudflare Turnstile Secret Key
  authSalt?: string; // Optional: Shared salt for dynamic token generation
  strictReplay?: boolean; // Optional: one-time tokens across all instances via the REPLAY Durable Object (default: false, per-instance memory)
  deviceKeys?: {
    mode: 'optional' | 'required'; // per-device signing keys derived from the master secret (see docs/hmac/DEVICE_KEYS.md)
    revoked?: string[]; // device IDs to refuse
    proof?: 'allowed' | 'required'; // ECDSA proof of possession with an enrolled public key (see docs/hmac/DEVICE_PROOF.md)
  };
  limits?: {
    allowedMethods?: string[]; // Optional: only these HTTP methods are proxied; others get 405 (default: all)
    maxBodyBytes?: number; // Optional: requests declaring a larger Content-Length get 413 (default: no cap)
  };
  rateLimit?: {
    enabled: boolean; // Enable rate limiting
    requestsPerWindow: number; // Number of requests allowed per window (e.g., 300)
    windowSeconds: number; // Time window in seconds (e.g., 300 = 5 minutes)
    hmacBypass?: boolean; // If true, authenticated (HMAC-verified) users bypass rate limits (default: false)
    hmacMultiplier?: number; // Multiplier for authenticated users (e.g., 2.0 = double limit, default: 1.0)
  };
  version: string;
}

export interface CachedConfig {
  config: ProxyConfig;
  cachedAt: number;
  ttl: number;
}

// Bindings and plain vars come from worker-configuration.d.ts (generated from wrangler.toml by `pnpm types`).
// Secrets are not in wrangler.toml, so they are listed here. METRICS stays optional on purpose: a missing
// binding must never break requests.
export interface Env extends Omit<Cloudflare.Env, 'METRICS' | 'REPLAY'> {
  METRICS?: AnalyticsEngineDataset;
  REPLAY?: DurableObjectNamespace; // Durable Object for strictReplay; optional so a missing binding never breaks non-strict requests
  LOG_SUCCESS_SAMPLE?: string; // 0 to 1: share of successful (below 400) request log lines to keep; default 1 (all)
  BACKEND_SECRET?: string; // Wrangler secret: sent to every backend so it can refuse traffic that skipped the proxy
  BACKEND_SECRET_HEADER?: string; // Header name for BACKEND_SECRET (default X-Proxy-Secret)
  ADMIN_KEY?: string; // Wrangler secret
  AUTH_SALT?: string; // Wrangler secret (HMAC key); overrides config.authSalt
  AUTH_KEYS?: string; // Wrangler secret: JSON {"key-id": "secret"}, selected by the X-Key-Id header
  TURNSTILE_SECRET_KEY?: string; // Wrangler secret; overrides config.turnstileSecretKey
}

/**
 * Validate and normalize a parsed config. Shared by the Worker and `pnpm validate-config`.
 * Throws on anything the Worker would reject (these rules are unchanged); `warnings` are
 * extra advice that never blocks a config, so a config that loads today still loads.
 */
function isHttps(u: unknown): boolean {
  try {
    return typeof u === 'string' && new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
}

const FORBIDDEN_INJECTED = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'x-request-id']);
function validateRouteOptions(r: Route): void {
  const bad = (what: string) => {
    throw new Error(`Invalid config: route ${r.prefix} ${what}`);
  };
  if (r.timeoutMs !== undefined && !(Number.isInteger(r.timeoutMs) && r.timeoutMs >= 1 && r.timeoutMs <= 600000))
    bad('timeoutMs must be an integer from 1 to 600000');
  if (
    r.methods !== undefined &&
    (!Array.isArray(r.methods) || !r.methods.length || !r.methods.every(m => typeof m === 'string' && /^[A-Za-z]+$/.test(m)))
  )
    bad('methods must be a non-empty array of method names');
  if (r.healthCheck !== undefined) {
    const h = r.healthCheck;
    if (!h || typeof h.path !== 'string' || !/^\/[A-Za-z0-9._~/-]*$/.test(h.path) || h.path.includes('//'))
      bad('healthCheck.path must start with "/" and use only letters, digits and . _ ~ - /');
    if (h.timeoutMs !== undefined && !(Number.isInteger(h.timeoutMs) && h.timeoutMs >= 100 && h.timeoutMs <= 10000))
      bad('healthCheck.timeoutMs must be an integer from 100 to 10000');
    if (!r.targets || r.targets.length < 2) bad('healthCheck needs at least two targets');
  }
  if (r.websocket !== undefined && typeof r.websocket !== 'boolean') bad('websocket must be true or false');
  if (r.stripPrefix !== undefined && typeof r.stripPrefix !== 'boolean') bad('stripPrefix must be true or false');
  if (r.allowedOrigins !== undefined && !(Array.isArray(r.allowedOrigins) && r.allowedOrigins.every(o => typeof o === 'string')))
    bad('allowedOrigins must be an array of strings');
  if (r.headers !== undefined) {
    if (!r.headers || typeof r.headers !== 'object' || Array.isArray(r.headers)) bad('headers must be an object');
    for (const [k, v] of Object.entries(r.headers)) {
      const name = k.toLowerCase();
      if (!/^[a-z0-9-]+$/.test(name) || FORBIDDEN_INJECTED.has(name) || name.startsWith('x-forwarded-')) bad(`headers cannot set "${k}"`);
      // No control characters (CR/LF would split the header).
      if (typeof v !== 'string' || [...v].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))
        bad(`header "${k}" must be a single-line string`);
    }
  }
}

/** A full origin such as https://app.example.com (scheme and host, no path, no wildcard). */
export function isFullOrigin(o: unknown): boolean {
  try {
    if (typeof o !== 'string') return false;
    const u = new URL(o);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === o;
  } catch {
    return false;
  }
}

/** The config as seen by one route: its own allowedOrigins, when set, replace the global list. */
export function forRoute(config: ProxyConfig, route?: Route): ProxyConfig {
  return route?.allowedOrigins ? { ...config, allowedOrigins: route.allowedOrigins } : config;
}

export function validateConfig(raw: unknown): { config: ProxyConfig; warnings: string[] } {
  const config = raw as ProxyConfig;
  if (!config || !Array.isArray(config.routes)) {
    throw new Error('Invalid config: routes must be an array');
  }

  for (const r of config.routes) {
    if (typeof r?.prefix !== 'string' || !r.prefix.startsWith('/')) {
      throw new Error('Invalid config: route.prefix must start with "/"');
    }
    if (r.targets !== undefined) {
      if (!Array.isArray(r.targets) || !r.targets.length) {
        throw new Error(`Invalid config: route ${r.prefix} targets must be a non-empty array`);
      }
      for (const t of r.targets) {
        const w = typeof t === 'string' ? 1 : (t?.weight ?? 1);
        if (!isHttps(typeof t === 'string' ? t : t?.url)) {
          throw new Error(`Invalid config: route ${r.prefix} target must be https`);
        }
        if (typeof w !== 'number' || !(w > 0)) {
          throw new Error(`Invalid config: route ${r.prefix} target weight must be a positive number`);
        }
      }
      const first = r.targets[0]!; // non-empty: checked above
      r.target ??= typeof first === 'string' ? first : first.url;
    }
    if (r.cacheTtl !== undefined) {
      if (typeof r.cacheTtl !== 'number' || !(r.cacheTtl > 0) || r.cacheTtl > 86400) {
        throw new Error(`Invalid config: route ${r.prefix} cacheTtl must be a number of seconds between 1 and 86400`);
      }
      // A shared cache must never serve one caller's authenticated response to another.
      if (r.hmacRequired) throw new Error(`Invalid config: route ${r.prefix} cannot combine cacheTtl with hmacRequired`);
    }
    validateRouteOptions(r);
    if (r.websocket) {
      // Browsers do not apply CORS to WebSockets, so the Worker must: fail closed without an exact-origin allowlist.
      const list = r.allowedOrigins ?? config.allowedOrigins;
      if (!Array.isArray(list) || !list.length || !list.every(isFullOrigin)) {
        throw new Error(
          `Invalid config: route ${r.prefix} websocket needs allowedOrigins (on the route or global) listing full origins such as https://app.example.com`
        );
      }
    }
    if (!isHttps(r.target)) {
      throw new Error(`Invalid config: route ${r.prefix} target must be https`);
    }
  }

  if (config.strictReplay !== undefined && typeof config.strictReplay !== 'boolean')
    throw new Error('Invalid config: strictReplay must be true or false');

  const dk = config.deviceKeys;
  if (dk !== undefined) {
    if (!dk || (dk.mode !== 'optional' && dk.mode !== 'required'))
      throw new Error('Invalid config: deviceKeys.mode must be "optional" or "required"');
    if (dk.proof !== undefined && dk.proof !== 'allowed' && dk.proof !== 'required')
      throw new Error('Invalid config: deviceKeys.proof must be "allowed" or "required"');
    if (
      dk.revoked !== undefined &&
      !(Array.isArray(dk.revoked) && dk.revoked.every(id => typeof id === 'string' && id.length >= 8 && id.length <= 64))
    ) {
      throw new Error('Invalid config: deviceKeys.revoked must be an array of device ids');
    }
  }

  const lim = config.limits;
  if (lim !== undefined) {
    if (lim === null || typeof lim !== 'object') throw new Error('Invalid config: limits must be an object');
    if (
      lim.allowedMethods !== undefined &&
      (!Array.isArray(lim.allowedMethods) ||
        !lim.allowedMethods.length ||
        !lim.allowedMethods.every(m => typeof m === 'string' && /^[A-Za-z]+$/.test(m)))
    ) {
      throw new Error('Invalid config: limits.allowedMethods must be a non-empty array of method names');
    }
    if (lim.maxBodyBytes !== undefined && !(Number.isInteger(lim.maxBodyBytes) && lim.maxBodyBytes > 0)) {
      throw new Error('Invalid config: limits.maxBodyBytes must be a positive integer');
    }
  }

  const warnings: string[] = [];
  const implicit = config.routes.filter(r => r.hmacRequired === undefined).map(r => r.prefix);
  if (implicit.length) {
    // Default stays false for backward compatibility; set it explicitly on every route.
    warnings.push(`hmacRequired not set (defaults to false) for routes: ${implicit.join(', ')}`);
  }
  const seen = new Set<string>();
  for (const r of config.routes) {
    if (seen.has(r.prefix)) warnings.push(`duplicate prefix ${r.prefix} (first match wins, the later route is unreachable)`);
    seen.add(r.prefix);
  }
  const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');
  for (const k of ['allowedOrigins', 'blockedOrigins'] as const) {
    if (config[k] !== undefined && !strings(config[k])) warnings.push(`${k} should be an array of strings`);
  }
  if (config.rateLimit?.enabled && !(config.rateLimit.requestsPerWindow > 0 && config.rateLimit.windowSeconds > 0)) {
    warnings.push('rateLimit needs positive requestsPerWindow and windowSeconds');
  }

  // Normalize routes: set hmacRequired default to false if missing
  config.routes = config.routes.map(route => ({ ...route, hmacRequired: route.hmacRequired ?? false }));
  return { config, warnings };
}

// In-memory cache (persists during worker execution)
let configCache: CachedConfig | null = null;

let inflight: Promise<ProxyConfig> | null = null;

/** Read KV and refresh the cache. On failure keep serving the cached copy, else an empty config. */
async function loadConfig(env: Env, cacheTTL: number): Promise<ProxyConfig> {
  try {
    const configJson = await env.PROXY_CONFIG.get('config');
    if (!configJson) {
      // No config found, return empty config
      const emptyConfig: ProxyConfig = { routes: [], version: '1.0' };
      configCache = { config: emptyConfig, cachedAt: Date.now(), ttl: cacheTTL };
      return emptyConfig;
    }

    const { config, warnings } = validateConfig(JSON.parse(configJson));
    for (const w of warnings) console.warn(`Config: ${w}`);
    configCache = { config, cachedAt: Date.now(), ttl: cacheTTL };
    return config;
  } catch (error) {
    console.error('Error loading config from KV:', error);
    return configCache?.config ?? { routes: [], version: '1.0' };
  }
}

/**
 * Stale-while-revalidate: a fresh cache is returned as is; an expired one is returned at once and
 * refreshed in the background (via `ctx.waitUntil`) so no request waits for KV. Only the first
 * request on a cold instance, or one without `ctx`, waits for the read.
 */
export async function getConfig(env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<ProxyConfig> {
  const cacheTTL = parseInt(env.CACHE_TTL || '60000', 10) || 60000; // 60 s default
  if (configCache && Date.now() - configCache.cachedAt < configCache.ttl) return configCache.config;

  // One shared read at a time, so a burst of stale requests triggers a single KV get.
  inflight ??= loadConfig(env, cacheTTL).finally(() => {
    inflight = null;
  });
  const refresh = inflight;
  if (configCache && ctx) {
    ctx.waitUntil(refresh);
    return configCache.config;
  }
  return refresh;
}

/** The request's execution context, or undefined when there is none (unit tests, plain fetch). */
export function execCtx(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }) {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

export function flushCache(): void {
  configCache = null;
  inflight = null;
}

/** Secrets come from Wrangler secrets first; KV config is a legacy fallback. */
export function getAuthSalt(config: ProxyConfig, env: Env): string | undefined {
  return env.AUTH_SALT || config.authSalt || undefined;
}

export function getTurnstileSecret(config: ProxyConfig, env: Env): string | undefined {
  return env.TURNSTILE_SECRET_KEY || config.turnstileSecretKey || undefined;
}

/** Named HMAC keys for rotation. A malformed or empty value means no named keys (never throws). */
export function getAuthKeys(env: Env): Record<string, string> {
  if (!env.AUTH_KEYS) return {};
  try {
    const parsed = JSON.parse(env.AUTH_KEYS) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [id, secret] of Object.entries(parsed)) if (typeof secret === 'string' && secret) out[id] = secret;
    return out;
  } catch {
    console.error('AUTH_KEYS is not valid JSON; ignoring it');
    return {};
  }
}
