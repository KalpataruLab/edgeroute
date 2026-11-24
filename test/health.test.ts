import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushCache, validateConfig, type Env } from '../src/config';
import { resetHealth, runHealthChecks } from '../src/health';
import { BACKEND, baseConfig, call, stubBackend } from './helpers';

const env = rawEnv as unknown as Env;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const A = `${BACKEND}/a`;
const B = `${BACKEND}/b`;
const route = { prefix: '/api', target: A, targets: [A, B], hmacRequired: false, healthCheck: { path: '/healthz' } };
const cfg = baseConfig({ routes: [route] });

async function runChecks(statusFor: (url: string) => number) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('', { status: statusFor(String(input)) });
    })
  );
  await env.PROXY_CONFIG.put('config', JSON.stringify(cfg));
  await env.PROXY_CONFIG.delete('health');
  flushCache();
  return { down: await runHealthChecks(env), calls };
}

describe('active health checks', () => {
  it('probes every target at the health path and records the ones that fail', async () => {
    const { down, calls } = await runChecks(u => (u.startsWith(B) ? 503 : 200));
    expect(calls.sort()).toEqual([`${A}/healthz`, `${B}/healthz`]);
    expect(down).toEqual([`/api|${B}`]);
    expect(JSON.parse((await env.PROXY_CONFIG.get('health')) as string).down).toEqual([`/api|${B}`]);
  });

  it('a 4xx answer still counts as alive', async () => {
    expect((await runChecks(() => 401)).down).toEqual([]);
  });

  it('requests skip a target the check found down', async () => {
    await runChecks(u => (u.startsWith(B) ? 500 : 200));
    resetHealth();
    const calls = stubBackend();
    for (let i = 0; i < 12; i++) await call('/api/x', {}, { config: cfg });
    expect(calls.length).toBe(12);
    expect(calls.every(r => r.url.startsWith(A))).toBe(true);
  });

  it('ignores a record that is too old', async () => {
    await env.PROXY_CONFIG.put('health', JSON.stringify({ at: Date.now() - 20 * 60_000, down: [`/api|${B}`, `/api|${A}`] }));
    resetHealth();
    const calls = stubBackend();
    await call('/api/x', {}, { config: cfg });
    expect(calls).toHaveLength(1); // served normally, not an error
  });

  it('does nothing when no route sets healthCheck', async () => {
    await env.PROXY_CONFIG.put('config', JSON.stringify(baseConfig()));
    flushCache();
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await runHealthChecks(env)).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it('sends the backend secret with the probe', async () => {
    const seen: Headers[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return new Response('', { status: 200 });
      })
    );
    await env.PROXY_CONFIG.put('config', JSON.stringify(cfg));
    flushCache();
    await runHealthChecks({ ...env, BACKEND_SECRET: 's3' } as Env);
    expect(seen.every(h => h.get('X-Proxy-Secret') === 's3')).toBe(true);
  });
});

describe('healthCheck validation', () => {
  it.each([
    ['no path', { healthCheck: {} }],
    ['path without a slash', { healthCheck: { path: 'healthz' } }],
    ['path with a query', { healthCheck: { path: '/h?x=1' } }],
    ['timeout too small', { healthCheck: { path: '/h', timeoutMs: 5 } }],
    ['a single target', { targets: [A], healthCheck: { path: '/h' } }]
  ])('rejects %s', (_n, over) => {
    expect(() => validateConfig({ routes: [{ ...route, ...over }] })).toThrow(/healthCheck/);
  });
});
