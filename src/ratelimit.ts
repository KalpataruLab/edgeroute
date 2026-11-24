/**
 * Rate Limiting Module - Hybrid Approach (Option C)
 *
 * Strategy:
 * - In-memory Map for fast lookups (per-isolate, resets on cold start)
 * - Fixed window algorithm (simple, efficient for edge computing)
 * - Per-IP baseline rate limiting
 * - Per-route multipliers
 * - HMAC authenticated users get bypass or higher limits
 *
 * Responses:
 * - Authenticated users (HMAC verified): 429 with details + Retry-After header
 * - Anonymous users: 403 silent (matches HMAC auth pattern)
 */

import type { ProxyConfig, Route } from './config';

interface RateLimitWindow {
  count: number;
  windowStart: number; // Unix timestamp in seconds
}

// In-memory storage (per-isolate, ephemeral)
const rateLimitStore = new Map<string, RateLimitWindow>();

// Cleanup interval to prevent memory leaks
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 600000; // 10 minutes

/**
 * Generate rate limit key based on IP and optional route prefix
 */
function getRateLimitKey(ip: string, routePrefix?: string): string {
  if (routePrefix) {
    return `${ip}:${routePrefix}`;
  }
  return ip;
}

/**
 * Calculate current window start time (Unix timestamp in seconds)
 */
function getCurrentWindow(windowSeconds: number): number {
  return Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
}

/**
 * Clean up old entries from the rate limit store
 */
function cleanupOldEntries(windowSeconds: number): void {
  const now = Date.now();

  // Only cleanup every CLEANUP_INTERVAL
  if (now - lastCleanup < CLEANUP_INTERVAL) {
    return;
  }

  const currentWindow = getCurrentWindow(windowSeconds);
  const entriesToDelete: string[] = [];

  // Find entries older than current window
  for (const [key, window] of rateLimitStore.entries()) {
    if (window.windowStart < currentWindow) {
      entriesToDelete.push(key);
    }
  }

  // Delete old entries
  for (const key of entriesToDelete) {
    rateLimitStore.delete(key);
  }

  lastCleanup = now;
}

/**
 * Check if request is within rate limit
 *
 * @param ip - Client IP address
 * @param config - Proxy configuration with rate limit settings
 * @param matchedRoute - Matched route (optional, for per-route multipliers)
 * @param isAuthenticated - Whether user passed HMAC authentication
 * @returns Object with allowed status and retry time if blocked
 */
export function checkRateLimit(
  ip: string,
  config: ProxyConfig,
  matchedRoute?: Route,
  isAuthenticated: boolean = false
): { allowed: boolean; retryAfter?: number; limit?: number; current?: number } {
  // If rate limiting is disabled, allow all
  if (!config.rateLimit?.enabled) {
    return { allowed: true };
  }

  const { requestsPerWindow, windowSeconds, hmacBypass, hmacMultiplier } = config.rateLimit;

  // If HMAC bypass is enabled and user is authenticated, bypass rate limiting
  if (hmacBypass && isAuthenticated) {
    return { allowed: true };
  }

  // Periodic cleanup of old entries
  cleanupOldEntries(windowSeconds);

  // Calculate effective limit based on route multiplier and HMAC multiplier
  let effectiveLimit = requestsPerWindow;

  // Apply route-specific multiplier
  if (matchedRoute?.rateLimitMultiplier) {
    effectiveLimit = Math.floor(effectiveLimit * matchedRoute.rateLimitMultiplier);
  }

  // Apply HMAC authenticated user multiplier
  if (isAuthenticated && hmacMultiplier) {
    effectiveLimit = Math.floor(effectiveLimit * hmacMultiplier);
  }

  // Get current window
  const currentWindow = getCurrentWindow(windowSeconds);

  // Generate key (per-IP, optionally scoped by route)
  const key = getRateLimitKey(ip, matchedRoute?.prefix);

  // Get or create window entry
  let windowEntry = rateLimitStore.get(key);

  // If no entry or window has rotated, create new window
  if (!windowEntry || windowEntry.windowStart < currentWindow) {
    windowEntry = {
      count: 0,
      windowStart: currentWindow
    };
    rateLimitStore.set(key, windowEntry);
  }

  // Check if limit exceeded
  if (windowEntry.count >= effectiveLimit) {
    const retryAfter = currentWindow + windowSeconds - Math.floor(Date.now() / 1000);
    return {
      allowed: false,
      retryAfter: Math.max(retryAfter, 1), // At least 1 second
      limit: effectiveLimit,
      current: windowEntry.count
    };
  }

  // Increment counter
  windowEntry.count++;

  return {
    allowed: true,
    limit: effectiveLimit,
    current: windowEntry.count
  };
}
