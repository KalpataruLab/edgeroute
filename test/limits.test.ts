import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../src/config';
import { baseConfig, call, stubBackend } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const withLimits = (limits: object) => ({ config: { ...baseConfig(), limits } });

describe('limits validation', () => {
  it.each([
    ['limits not an object', 'x'],
    ['empty methods', { allowedMethods: [] }],
    ['method not a string', { allowedMethods: [1] }],
    ['method with odd characters', { allowedMethods: ['GET, POST'] }],
    ['zero cap', { maxBodyBytes: 0 }],
    ['fractional cap', { maxBodyBytes: 1.5 }],
    ['string cap', { maxBodyBytes: '10' }]
  ])('rejects %s', (_n, limits) => {
    expect(() => validateConfig({ ...baseConfig(), limits })).toThrow(/Invalid config: limits/);
  });

  it('accepts valid limits', () => {
    expect(() => validateConfig({ ...baseConfig(), limits: { allowedMethods: ['GET', 'post'], maxBodyBytes: 1000 } })).not.toThrow();
  });
});

describe('allowedMethods', () => {
  it('rejects other methods with 405 and an Allow header, without calling the backend', async () => {
    const calls = stubBackend();
    const res = await call('/api/x', { method: 'DELETE' }, withLimits({ allowedMethods: ['GET', 'POST'] }));
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, POST');
    expect(calls).toHaveLength(0);
  });

  it('lets listed methods through, case-insensitively', async () => {
    stubBackend();
    const res = await call('/api/x', { method: 'POST', body: 'a' }, withLimits({ allowedMethods: ['get', 'post'] }));
    expect(res.status).toBe(200);
  });

  it('applies to HMAC routes too', async () => {
    const calls = stubBackend();
    const res = await call('/api/secure/x', { method: 'PUT' }, withLimits({ allowedMethods: ['GET'] }));
    expect(res.status).toBe(405);
    expect(calls).toHaveLength(0);
  });
});

describe('maxBodyBytes', () => {
  it('rejects a declared length over the cap with 413', async () => {
    const calls = stubBackend();
    const res = await call(
      '/api/x',
      { method: 'POST', body: 'x'.repeat(20), headers: { 'Content-Length': '20' } },
      withLimits({ maxBodyBytes: 10 })
    );
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('allows a body at the cap and requests with no body', async () => {
    stubBackend();
    const ok = await call(
      '/api/x',
      { method: 'POST', body: 'x'.repeat(10), headers: { 'Content-Length': '10' } },
      withLimits({ maxBodyBytes: 10 })
    );
    expect(ok.status).toBe(200);
    const get = await call('/api/x', {}, withLimits({ maxBodyBytes: 10 }));
    expect(get.status).toBe(200);
  });
});

describe('no limits configured', () => {
  it('changes nothing', async () => {
    stubBackend();
    const res = await call('/api/x', { method: 'DELETE' });
    expect(res.status).toBe(200);
  });
});
