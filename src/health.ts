import { keyOf, routeTargets } from './balancer';
import { type Env, getConfig } from './config';

// Active health checks. A Cron Trigger probes the targets of routes that set `healthCheck` and stores which
// are down in the existing PROXY_CONFIG KV namespace (key "health"), so every Worker instance shares one view.
// No new binding. KV is written only when the result changes (or every 5 minutes), to stay well under write limits.
const KEY = 'health';
const STALE_MS = 15 * 60_000; // a record older than this is ignored (the cron stopped), so nothing stays down forever
const REFRESH_MS = 5 * 60_000;
const LOCAL_TTL_MS = 30_000; // each instance re-reads KV at most this often

interface HealthState {
  at: number;
  down: string[]; // keyOf(route prefix, target url)
}

let local: { down: Set<string>; loadedAt: number } = { down: new Set(), loadedAt: 0 };

export function resetHealth(): void {
  local = { down: new Set(), loadedAt: 0 };
}

/** Targets the last health check found down, as keyOf(prefix, url). Empty when unknown or stale. */
export async function sharedDown(env: Env, now = Date.now()): Promise<ReadonlySet<string>> {
  if (now - local.loadedAt < LOCAL_TTL_MS) return local.down;
  try {
    const raw = await env.PROXY_CONFIG.get(KEY);
    const s = raw ? (JSON.parse(raw) as HealthState) : null;
    local = { down: s && now - s.at < STALE_MS && Array.isArray(s.down) ? new Set(s.down) : new Set(), loadedAt: now };
  } catch {
    local.loadedAt = now; // keep the previous view; never break requests over this
  }
  return local.down;
}

async function probe(url: string, path: string, timeoutMs: number, env: Env): Promise<boolean> {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/\/+$/, '') + path;
  u.search = '';
  const headers = new Headers();
  if (env.BACKEND_SECRET) {
    const name = /^[A-Za-z0-9-]+$/.test(env.BACKEND_SECRET_HEADER ?? '') ? (env.BACKEND_SECRET_HEADER as string) : 'X-Proxy-Secret';
    headers.set(name, env.BACKEND_SECRET); // so a locked-down backend does not refuse the probe
  }
  try {
    const res = await fetch(u.toString(), { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    void res.body?.cancel();
    return res.status < 500; // a 401/404 still means the backend is alive; 5xx or no answer means down
  } catch {
    return false;
  }
}

/** Probe every target of routes with `healthCheck` and save the result. Run by the Cron Trigger. */
export async function runHealthChecks(env: Env, now = Date.now()): Promise<string[]> {
  const config = await getConfig(env);
  const jobs: Array<Promise<readonly [string, boolean]>> = [];
  for (const route of config.routes) {
    const hc = route.healthCheck;
    if (!hc) continue;
    for (const t of routeTargets(route)) {
      const key = keyOf(route.prefix, t.url);
      jobs.push(probe(t.url, hc.path, hc.timeoutMs ?? 3000, env).then(ok => [key, ok] as const));
    }
  }
  if (!jobs.length) return [];
  const down = (await Promise.all(jobs))
    .filter(([, ok]) => !ok)
    .map(([k]) => k)
    .sort();

  let prev: HealthState | null = null;
  try {
    const raw = await env.PROXY_CONFIG.get(KEY);
    prev = raw ? (JSON.parse(raw) as HealthState) : null;
  } catch {
    prev = null;
  }
  if (!prev || prev.down.join('\n') !== down.join('\n') || now - prev.at >= REFRESH_MS) {
    await env.PROXY_CONFIG.put(KEY, JSON.stringify({ at: now, down } satisfies HealthState));
  }
  return down;
}
