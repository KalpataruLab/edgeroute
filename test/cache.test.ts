import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../src/config';
import { BACKEND, baseConfig, call, stubBackend } from './helpers';

const cfg = (extra = {}) => baseConfig({ routes: [{ prefix: '/c', target: `${BACKEND}/c`, hmacRequired: false, cacheTtl: 60, ...extra }] });
const body =
  (headers: Record<string, string> = {}) =>
  () =>
    new Response('hello', { status: 200, headers: { 'Content-Length': '5', ...headers } });
let n = 0;
const path = () => `/c/${Date.now()}-${n++}`; // the Cache API outlives a test, so each test gets its own URL

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cacheTtl validation', () => {
  it.each([[0], [-1], ['x'], [86401]])('rejects cacheTtl %s', v => {
    expect(() => validateConfig({ routes: [{ prefix: '/', target: BACKEND, cacheTtl: v }] })).toThrow(/cacheTtl/);
  });
  it('rejects cacheTtl with hmacRequired', () => {
    expect(() => validateConfig({ routes: [{ prefix: '/', target: BACKEND, cacheTtl: 5, hmacRequired: true }] })).toThrow(/hmacRequired/);
  });
});

describe('edge cache', () => {
  it('serves the second GET from the cache', async () => {
    const calls = stubBackend(body());
    const p = path();
    const a = await call(p, {}, { config: cfg() });
    const b = await call(p, {}, { config: cfg() });
    expect(await a.text()).toBe('hello');
    expect(await b.text()).toBe('hello');
    expect(b.headers.get('X-Cache')).toBe('HIT');
    expect(calls).toHaveLength(1);
  });

  it('applies the current CORS policy to a cached response', async () => {
    stubBackend(body({ 'Access-Control-Allow-Origin': 'https://evil.example.test' }));
    const p = path();
    await call(p, {}, { config: cfg() });
    const b = await call(p, { headers: { Origin: 'https://evil.example.test' } }, { config: cfg() });
    expect(b.headers.get('X-Cache')).toBe('HIT');
    expect(b.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example.test');
  });

  it('does not cache routes without cacheTtl', async () => {
    const calls = stubBackend(body());
    const p = path();
    const plain = baseConfig({ routes: [{ prefix: '/c', target: `${BACKEND}/c`, hmacRequired: false }] });
    await call(p, {}, { config: plain });
    await call(p, {}, { config: plain });
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['Authorization', { Authorization: 'Bearer x' }],
    ['Cookie', { Cookie: 'a=b' }],
    ['X-Device-Id', { 'X-Device-Id': 'd1' }],
    ['X-Auth-Token', { 'X-Auth-Token': 't' }]
  ])('never caches requests that send %s', async (_n, h) => {
    const calls = stubBackend(body());
    const p = path();
    await call(p, { headers: h }, { config: cfg() });
    await call(p, { headers: h }, { config: cfg() });
    await call(p, {}, { config: cfg() }); // and an anonymous caller gets nothing stored by them
    expect(calls).toHaveLength(3);
  });

  it.each([
    ['Set-Cookie', { 'Set-Cookie': 'a=b' }],
    ['Cache-Control: private', { 'Cache-Control': 'private' }],
    ['Cache-Control: no-store', { 'Cache-Control': 'no-store' }],
    ['Cache-Control: max-age=0', { 'Cache-Control': 'max-age=0' }],
    ['Cache-Control: private="X"', { 'Cache-Control': 'private="X-Foo"' }],
    ['Cache-Control: no-cache="X"', { 'Cache-Control': 'no-cache="Set-Cookie"' }],
    ['Cache-Control: s-maxage=0', { 'Cache-Control': 'public, s-maxage=0' }],
    ['Cache-Control: max-age = 0', { 'Cache-Control': 'public, max-age = 0' }],
    ['Cache-Control: private with spaces', { 'Cache-Control': 'public  private' }],
    ['Cache-Control: semicolon', { 'Cache-Control': 'public; no-store' }],
    ['Vary: *', { Vary: '*' }],
    ['Vary: X-Tenant', { Vary: 'X-Tenant' }]
  ])('does not store responses with %s', async (_n, h) => {
    const calls = stubBackend(body(h));
    const p = path();
    await call(p, {}, { config: cfg() });
    await call(p, {}, { config: cfg() });
    expect(calls).toHaveLength(2);
  });

  it('does not store non-200, POST, or bodies of unknown or large size', async () => {
    const p1 = path();
    let calls = stubBackend(() => new Response('nope', { status: 404, headers: { 'Content-Length': '4' } }));
    await call(p1, {}, { config: cfg() });
    await call(p1, {}, { config: cfg() });
    expect(calls).toHaveLength(2);

    calls = stubBackend(() => new Response('x', { status: 200 })); // no Content-Length
    const p2 = path();
    await call(p2, {}, { config: cfg() });
    await call(p2, {}, { config: cfg() });
    expect(calls).toHaveLength(2);

    calls = stubBackend(body({ 'Content-Length': String(2 * 1024 * 1024) }));
    const p3 = path();
    await call(p3, {}, { config: cfg() });
    await call(p3, {}, { config: cfg() });
    expect(calls).toHaveLength(2);

    calls = stubBackend(body());
    const p4 = path();
    await call(p4, { method: 'POST', body: 'x' }, { config: cfg() });
    await call(p4, { method: 'POST', body: 'x' }, { config: cfg() });
    expect(calls).toHaveLength(2);
  });
});
