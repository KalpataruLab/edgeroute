import type { ProxyConfig } from './config';

/**
 * Checks if the request is explicitly blocked.
 * Checks: Origin, Referer, and cf-worker header.
 */
export function isCallerBlocked(request: Request, config: ProxyConfig): boolean {
  if (!config.blockedOrigins || config.blockedOrigins.length === 0) {
    return false;
  }

  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  const cfWorker = request.headers.get('cf-worker');

  const hostOf = (v: string): string => {
    try {
      return new URL(v).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      return v.toLowerCase().replace(/\.$/, '');
    }
  };
  // Match on the parsed hostname (exact or subdomain), not a substring.
  const matches = (value: string | null, blocked: string): boolean => {
    if (!value) return false;
    const host = hostOf(value);
    const b = hostOf(blocked);
    return host === b || host.endsWith('.' + b);
  };

  return config.blockedOrigins.some(blocked => matches(origin, blocked) || matches(referer, blocked) || matches(cfWorker, blocked));
}

/**
 * Checks if the request's Origin is allowed.
 * - If config.allowedOrigins is missing or empty, ALLOW all (default behavior).
 * - If Origin header is missing, ALLOW (assumes non-browser tool like curl/server).
 * - If Origin is present, it MUST match one of the entries in allowedOrigins.
 * - Supports wildcard patterns: "*.example.com" matches "app.example.com", "api.example.com", etc.
 */
export function isOriginAllowed(origin: string | null, config: ProxyConfig): boolean {
  if (!config.allowedOrigins || config.allowedOrigins.length === 0) {
    return true;
  }
  // Allow non-browser requests (no Origin header)
  if (!origin) {
    return true;
  }

  // Extract hostname from origin URL (e.g., "https://app.example.com" -> "app.example.com")
  let originHostname: string;
  try {
    const originUrl = new URL(origin);
    originHostname = originUrl.hostname;
  } catch {
    // If origin is not a valid URL, use it as-is for comparison
    originHostname = origin;
  }

  return config.allowedOrigins.some(allowed => {
    // Exact match (supports full URLs or hostnames)
    if (allowed === origin || allowed === originHostname) {
      return true;
    }

    // Wildcard match: "*.example.com" matches "app.example.com"
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(2); // Remove "*."
      return originHostname.endsWith('.' + domain) || originHostname === domain;
    }

    return false;
  });
}

/**
 * True if the path contains an encoded dot-segment, slash or backslash.
 * The URL parser does not normalize these, but a backend might decode them
 * and walk out of the route's base path.
 */
export function hasEncodedTraversal(pathname: string): boolean {
  return /%2e|%2f|%5c/i.test(pathname) || pathname.includes('\\');
}
