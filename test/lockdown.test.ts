import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKEND, baseConfig, call, stubBackend } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('backend lock-down secret', () => {
  it('sends BACKEND_SECRET in X-Proxy-Secret on every backend request', async () => {
    const calls = stubBackend();
    await call('/api/x', {}, { envOver: { BACKEND_SECRET: 's3cret-value' } });
    expect(calls[0]!.headers.get('X-Proxy-Secret')).toBe('s3cret-value');
  });

  it('replaces a client-supplied value', async () => {
    const calls = stubBackend();
    await call('/api/x', { headers: { 'X-Proxy-Secret': 'guess' } }, { envOver: { BACKEND_SECRET: 'real' } });
    expect(calls[0]!.headers.get('X-Proxy-Secret')).toBe('real');
  });

  it('strips a client-supplied value even when no secret is set', async () => {
    const calls = stubBackend();
    await call('/api/x', { headers: { 'X-Proxy-Secret': 'guess' } });
    expect(calls[0]!.headers.has('X-Proxy-Secret')).toBe(false);
  });

  it('cannot be overridden by a route header', async () => {
    const calls = stubBackend();
    const config = baseConfig({
      routes: [{ prefix: '/api', target: `${BACKEND}/api`, hmacRequired: false, headers: { 'X-Proxy-Secret': 'from-config' } }]
    });
    await call('/api/x', {}, { config, envOver: { BACKEND_SECRET: 'real' } });
    expect(calls[0]!.headers.get('X-Proxy-Secret')).toBe('real');
  });

  it('uses BACKEND_SECRET_HEADER when it is a valid name, else the default', async () => {
    let calls = stubBackend();
    await call('/api/x', {}, { envOver: { BACKEND_SECRET: 'v', BACKEND_SECRET_HEADER: 'X-Origin-Auth' } });
    expect(calls[0]!.headers.get('X-Origin-Auth')).toBe('v');
    calls = stubBackend();
    await call('/api/x', {}, { envOver: { BACKEND_SECRET: 'v', BACKEND_SECRET_HEADER: 'bad name' } });
    expect(calls[0]!.headers.get('X-Proxy-Secret')).toBe('v');
  });

  it('is also sent on a failover retry', async () => {
    const calls = stubBackend(() => new Response('', { status: 503 }));
    const config = baseConfig({
      routes: [{ prefix: '/api', target: `${BACKEND}/a`, targets: [`${BACKEND}/a`, `${BACKEND}/b`], hmacRequired: false }]
    });
    await call('/api/x', {}, { config, envOver: { BACKEND_SECRET: 'v' } });
    expect(calls).toHaveLength(2);
    expect(calls.every(r => r.headers.get('X-Proxy-Secret') === 'v')).toBe(true);
  });
});
