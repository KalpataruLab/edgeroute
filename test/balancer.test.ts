import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAIL_THRESHOLD, OPEN_MS, pickTarget, recordResult, resetBreakers, routeTargets } from '../src/balancer';
import { validateConfig } from '../src/config';
import { baseConfig, call } from './helpers';

const A = 'https://a.example.test';
const B = 'https://b.example.test';
const two = [
  { url: A, weight: 1 },
  { url: B, weight: 1 }
];

beforeEach(() => {
  resetBreakers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('routeTargets / validateConfig', () => {
  it('uses target when targets is absent', () => {
    expect(routeTargets({ prefix: '/', target: A })).toEqual([{ url: A, weight: 1 }]);
  });

  it('accepts strings and weighted objects, and fills target from the first entry', () => {
    const { config } = validateConfig({ routes: [{ prefix: '/', targets: [A, { url: B, weight: 3 }] }] });
    expect(config.routes[0]!.target).toBe(A);
    expect(routeTargets(config.routes[0]!)).toEqual([
      { url: A, weight: 1 },
      { url: B, weight: 3 }
    ]);
  });

  it.each([
    ['empty targets', { prefix: '/', targets: [] }],
    ['http target in list', { prefix: '/', targets: [A, 'http://b.example.test'] }],
    ['zero weight', { prefix: '/', targets: [{ url: A, weight: 0 }] }],
    ['bad weight type', { prefix: '/', targets: [{ url: A, weight: 'x' }] }]
  ])('rejects %s', (_n, route) => {
    expect(() => validateConfig({ routes: [route] })).toThrow(/Invalid config/);
  });
});

describe('pickTarget', () => {
  it('follows weights', () => {
    const t = [
      { url: A, weight: 1 },
      { url: B, weight: 3 }
    ];
    expect(pickTarget(t, new Set(), 'r', 0, () => 0.1)?.url).toBe(A);
    expect(pickTarget(t, new Set(), 'r', 0, () => 0.3)?.url).toBe(B);
  });

  it('skips excluded targets and returns null when none are left', () => {
    expect(pickTarget(two, new Set([A]), 'r')?.url).toBe(B);
    expect(pickTarget(two, new Set([A, B]), 'r')).toBeNull();
  });

  it('skips an open circuit, then tries it again after the cool-down', () => {
    for (let i = 0; i < FAIL_THRESHOLD; i++) recordResult('r', A, false, 1000);
    expect(pickTarget(two, new Set(), 'r', 1000 + 1, () => 0)?.url).toBe(B);
    expect(pickTarget(two, new Set(), 'r', 1000 + OPEN_MS + 1, () => 0)?.url).toBe(A);
  });

  it('fails open when every circuit is open', () => {
    for (const u of [A, B]) for (let i = 0; i < FAIL_THRESHOLD; i++) recordResult('r', u, false, 1000);
    expect(pickTarget(two, new Set(), 'r', 1001)).not.toBeNull();
  });

  it('failures on one route do not open the circuit for another route', () => {
    for (let i = 0; i < FAIL_THRESHOLD; i++) recordResult('/public', A, false, 1000);
    expect(pickTarget(two, new Set(), '/secure', 1001, () => 0)?.url).toBe(A);
  });

  it('a success closes the circuit', () => {
    for (let i = 0; i < FAIL_THRESHOLD; i++) recordResult('r', A, false, 1000);
    recordResult('r', A, true, 1001);
    expect(pickTarget(two, new Set(), 'r', 1002, () => 0)?.url).toBe(A);
  });
});

describe('failover through the proxy', () => {
  const cfg = (extra = {}) => baseConfig({ routes: [{ prefix: '/lb', targets: [A, B], hmacRequired: false, ...extra } as never] });
  /** Backend stub: hosts in `down` answer with `status` (or throw when status is 0). */
  const backends = (down: Record<string, number>) => {
    const hits: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const host = new URL(input instanceof Request ? input.url : String(input)).origin;
        hits.push(host);
        const s = down[host];
        if (s === 0) throw new Error('connect refused');
        return new Response(`from ${host}`, { status: s ?? 200 });
      })
    );
    return hits;
  };

  it('GET fails over to the other target on 503', async () => {
    const hits = backends({ [A]: 503 });
    vi.spyOn(Math, 'random').mockReturnValue(0); // first pick is A
    const res = await call('/lb/x', {}, { config: cfg() });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`from ${B}`);
    expect(hits).toEqual([A, B]);
  });

  it('GET fails over after a connection error', async () => {
    backends({ [A]: 0 });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const res = await call('/lb/x', {}, { config: cfg() });
    expect(res.status).toBe(200);
  });

  it('retries once at most and returns the last backend response', async () => {
    const hits = backends({ [A]: 503, [B]: 502 });
    const res = await call('/lb/x', {}, { config: cfg() });
    expect([502, 503]).toContain(res.status); // whichever target was tried last
    expect(hits).toHaveLength(2);
    expect(new Set(hits).size).toBe(2);
  });

  it('returns the generic 503 when both targets throw', async () => {
    backends({ [A]: 0, [B]: 0 });
    const res = await call('/lb/x', {}, { config: cfg() });
    expect(res.status).toBe(503);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(['error', 'requestId']);
  });

  it('does not fail over on a normal error status such as 404 or 500', async () => {
    const hits = backends({ [A]: 500, [B]: 500 });
    const res = await call('/lb/x', {}, { config: cfg() });
    expect(res.status).toBe(500);
    expect(hits).toHaveLength(1);
  });

  it('does not retry POST', async () => {
    const hits = backends({ [A]: 503, [B]: 503 });
    const res = await call('/lb/x', { method: 'POST', body: 'x' }, { config: cfg() });
    expect(res.status).toBe(503);
    expect(hits).toHaveLength(1);
  });

  it('does not retry with a single target', async () => {
    const hits = backends({ [A]: 503 });
    const res = await call('/lb/x', {}, { config: baseConfig({ routes: [{ prefix: '/lb', target: A, hmacRequired: false }] }) });
    expect(res.status).toBe(503);
    expect(hits).toHaveLength(1);
  });

  it('stops sending to a target after repeated failures', async () => {
    const hits = backends({});
    vi.spyOn(Math, 'random').mockReturnValue(0); // would pick A first
    for (let i = 0; i < FAIL_THRESHOLD; i++) recordResult('/lb', A, false);
    const res = await call('/lb/x', {}, { config: cfg(), keepBreakers: true });
    expect(res.status).toBe(200);
    expect(hits).toEqual([B]);
  });
});
