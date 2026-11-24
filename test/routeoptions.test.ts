import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig, type Route } from '../src/config';
import { BACKEND, baseConfig, call, stubBackend } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const route = (over: Partial<Route>): Route => ({ prefix: '/api', target: `${BACKEND}/api`, hmacRequired: false, ...over });
const cfg = (over: Partial<Route>) => ({ config: baseConfig({ routes: [route(over)] }) });

describe('route option validation', () => {
  it.each([
    ['timeoutMs 0', { timeoutMs: 0 }],
    ['timeoutMs fractional', { timeoutMs: 1.5 }],
    ['timeoutMs too large', { timeoutMs: 700000 }],
    ['empty methods', { methods: [] }],
    ['bad method', { methods: ['GET POST'] }],
    ['stripPrefix string', { stripPrefix: 'no' }],
    ['allowedOrigins not strings', { allowedOrigins: [1] }],
    ['headers array', { headers: ['a'] }],
    ['header Host', { headers: { Host: 'evil.example' } }],
    ['header X-Forwarded-For', { headers: { 'X-Forwarded-For': '1.1.1.1' } }],
    ['header X-Request-Id', { headers: { 'X-Request-Id': 'x' } }],
    ['header with newline', { headers: { 'X-A': 'a\nb' } }],
    ['header name with space', { headers: { 'X A': 'a' } }],
    ['header value not a string', { headers: { 'X-A': 1 } }]
  ])('rejects %s', (_n, over) => {
    expect(() => validateConfig({ routes: [{ ...route({}), ...over }] })).toThrow(/Invalid config: route \/api/);
  });
});

describe('methods', () => {
  it('405 with Allow for other methods; listed ones pass', async () => {
    const calls = stubBackend();
    const bad = await call('/api/x', { method: 'DELETE' }, cfg({ methods: ['get', 'POST'] }));
    expect(bad.status).toBe(405);
    expect(bad.headers.get('Allow')).toBe('GET, POST');
    expect(calls).toHaveLength(0);
    const ok = await call('/api/x', { method: 'POST', body: 'a' }, cfg({ methods: ['get', 'POST'] }));
    expect(ok.status).toBe(200);
  });
});

describe('stripPrefix', () => {
  it('strips by default and keeps the prefix when false', async () => {
    let calls = stubBackend();
    await call('/api/users?x=1', {}, cfg({}));
    expect(calls[0]!.url).toBe(`${BACKEND}/api/users?x=1`);
    calls = stubBackend();
    await call('/api/users?x=1', {}, cfg({ target: BACKEND, stripPrefix: false }));
    expect(calls[0]!.url).toBe(`${BACKEND}/api/users?x=1`);
    calls = stubBackend();
    await call('/api/users', {}, cfg({ target: `${BACKEND}/v2`, stripPrefix: false }));
    expect(calls[0]!.url).toBe(`${BACKEND}/v2/api/users`);
  });
});

describe('injected headers', () => {
  it('sets them on the backend request, overriding the client value', async () => {
    const calls = stubBackend();
    await call('/api/x', { headers: { 'X-Tenant': 'client' } }, cfg({ headers: { 'X-Tenant': 'acme', 'X-Via': 'proxy' } }));
    expect(calls[0]!.headers.get('X-Tenant')).toBe('acme');
    expect(calls[0]!.headers.get('X-Via')).toBe('proxy');
  });
});

describe('timeoutMs', () => {
  it('aborts a slow backend at the route timeout with 504', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u: unknown, init?: RequestInit) =>
          new Promise((_res, rej) => {
            init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          })
      )
    );
    const res = await call('/api/x', {}, cfg({ timeoutMs: 20 }));
    expect(res.status).toBe(504);
  });
});

describe('per-route allowedOrigins', () => {
  const config = baseConfig({
    allowedOrigins: ['https://global.example.test'],
    routes: [route({ prefix: '/open', target: `${BACKEND}/o`, allowedOrigins: ['https://open.example.test'] }), route({})]
  });

  it('replaces the global list for that route only', async () => {
    stubBackend();
    const ok = await call('/open/x', { headers: { Origin: 'https://open.example.test' } }, { config });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://open.example.test');
    const globalOnOpen = await call('/open/x', { headers: { Origin: 'https://global.example.test' } }, { config });
    expect(globalOnOpen.status).toBe(403);
    const openOnApi = await call('/api/x', { headers: { Origin: 'https://open.example.test' } }, { config });
    expect(openOnApi.status).toBe(403);
    const globalOnApi = await call('/api/x', { headers: { Origin: 'https://global.example.test' } }, { config });
    expect(globalOnApi.status).toBe(200);
  });

  it('preflight uses the route list', async () => {
    const pre = (path: string, origin: string) =>
      call(path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } }, { config });
    expect((await pre('/open/x', 'https://open.example.test')).headers.get('Access-Control-Allow-Origin')).toBe(
      'https://open.example.test'
    );
    expect((await pre('/open/x', 'https://global.example.test')).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
