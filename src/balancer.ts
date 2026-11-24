import type { Route } from './config';

export interface Target {
  url: string;
  weight: number;
}

/** Status codes treated as "this backend is unhealthy" (failover and circuit breaker). */
export const RETRY_STATUSES = new Set([502, 503, 504]);
export const FAIL_THRESHOLD = 3; // consecutive failures that open the circuit
export const OPEN_MS = 30_000; // how long an open circuit is skipped

// ponytail: breaker state is per Worker instance (memory only), like replay and rate limits.
// Upgrade to a Durable Object or the active health checks in the roadmap for a shared view.
const breakers = new Map<string, { fails: number; openUntil: number }>();

export function resetBreakers(): void {
  breakers.clear();
}

/** All targets of a route: `targets` when set, otherwise the single `target`. */
export function routeTargets(route: Route): Target[] {
  if (!route.targets?.length) return [{ url: route.target, weight: 1 }];
  return route.targets.map(t => (typeof t === 'string' ? { url: t, weight: 1 } : { url: t.url, weight: t.weight ?? 1 }));
}

// State is scoped per route (its prefix), so failures seen on one route (for example a public one)
// cannot open the circuit for another route that shares the same backend.
export const keyOf = (scope: string, url: string) => `${scope}|${url}`;
const isOpen = (scope: string, url: string, now: number) => (breakers.get(keyOf(scope, url))?.openUntil ?? 0) > now;

/**
 * Weighted random pick among targets not in `exclude`, skipping open circuits.
 * If every remaining circuit is open it picks anyway (fail open): a guess beats a guaranteed error.
 */
export function pickTarget(
  targets: Target[],
  exclude: ReadonlySet<string>,
  scope: string,
  now = Date.now(),
  random = Math.random,
  down: ReadonlySet<string> = new Set() // targets the active health check found down (see health.ts)
): Target | null {
  const candidates = targets.filter(t => !exclude.has(t.url));
  if (!candidates.length) return null;
  const healthy = candidates.filter(t => !isOpen(scope, t.url, now) && !down.has(keyOf(scope, t.url)));
  const pool = healthy.length ? healthy : candidates;
  let roll = random() * pool.reduce((s, t) => s + t.weight, 0);
  for (const t of pool) {
    roll -= t.weight;
    if (roll < 0) return t;
  }
  return pool[pool.length - 1] ?? null;
}

export function recordResult(scope: string, url: string, ok: boolean, now = Date.now()): void {
  const key = keyOf(scope, url);
  if (ok) {
    breakers.delete(key);
    return;
  }
  const b = breakers.get(key) ?? { fails: 0, openUntil: 0 };
  b.fails += 1;
  if (b.fails >= FAIL_THRESHOLD) b.openUntil = now + OPEN_MS; // stays failing until a success resets it
  breakers.set(key, b);
}
