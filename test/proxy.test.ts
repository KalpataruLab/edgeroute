import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKEND, SECRET, baseConfig, call, signed, stubBackend } from './helpers';

const withSecret = { envOver: { AUTH_SALT: SECRET } };

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('routing', () => {
  it('forwards to the target with prefix removed and query kept', async () => {
    const calls = stubBackend();
    const res = await call('/api/users/1?x=2');
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(`${BACKEND}/api/users/1?x=2`);
  });

  it('matches on a path boundary, not a raw string prefix', async () => {
    stubBackend();
    expect((await call('/apix')).status).toBe(404);
    expect((await call('/api')).status).toBe(200);
  });

  it('first match wins', async () => {
    const calls = stubBackend();
    await call(
      '/api/secure/a',
      {},
      {
        config: baseConfig({
          routes: [
            { prefix: '/api', target: `${BACKEND}/first`, hmacRequired: false },
            { prefix: '/api/secure', target: `${BACKEND}/second`, hmacRequired: false }
          ]
        })
      }
    );
    expect(calls[0]!.url).toBe(`${BACKEND}/first/secure/a`);
  });

  it('returns 404 when no route matches', async () => {
    expect((await call('/nope')).status).toBe(404);
  });

  it('strips proxy-only headers and sets forwarding headers', async () => {
    const calls = stubBackend();
    await call('/api/x', {
      headers: {
        'X-Admin-Key': 'k',
        'X-Nonce': 'n',
        Origin: 'https://o.example.test',
        'CF-Connecting-IP': '203.0.113.9',
        'X-Forwarded-For': '1.2.3.4'
      }
    });
    const h = calls[0]!.headers;
    for (const n of ['x-admin-key', 'x-nonce', 'origin']) expect(h.get(n)).toBeNull();
    expect(h.get('x-forwarded-for')).toBe('203.0.113.9');
  });

  it('health endpoint answers without a backend call', async () => {
    const calls = stubBackend();
    expect((await call('/health')).status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});

describe('encoded paths', () => {
  it.each(['/api/a%2Fb', '/api/a%2fb', '/api/a%5Cb', '/api/a%2e'])('rejects %s with 400', async p => {
    const calls = stubBackend();
    expect((await call(p)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('never forwards %2e%2e: the URL parser already collapses it, so it cannot escape the route', async () => {
    const calls = stubBackend();
    await call('/api/%2e%2e/x');
    expect(calls.every(c => new URL(c.url).pathname.startsWith('/api'))).toBe(true);
  });
});

describe('CORS', () => {
  const cfg = baseConfig({ allowedOrigins: ['https://app.example.test', '*.ok.example.test'] });

  it('allows a listed origin and echoes it', async () => {
    stubBackend();
    const res = await call('/api/x', { headers: { Origin: 'https://app.example.test' } }, { config: cfg });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.test');
  });

  it('allows a wildcard subdomain', async () => {
    stubBackend();
    const res = await call('/api/x', { headers: { Origin: 'https://a.ok.example.test' } }, { config: cfg });
    expect(res.status).toBe(200);
  });

  it('blocks an unlisted origin with 403 and no allow-origin header', async () => {
    const calls = stubBackend();
    const res = await call('/api/x', { headers: { Origin: 'https://evil.example.test' } }, { config: cfg });
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('replaces CORS headers sent by the backend', async () => {
    stubBackend(() => new Response('ok', { headers: { 'Access-Control-Allow-Origin': 'https://evil.example.test' } }));
    const res = await call('/api/x', { headers: { Origin: 'https://app.example.test' } }, { config: cfg });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.test');
  });

  it('allows any origin (*) when no allowlist is set', async () => {
    stubBackend();
    const res = await call('/api/x', { headers: { Origin: 'https://any.example.test' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('answers preflight from an allowed origin with 204', async () => {
    const calls = stubBackend();
    const res = await call(
      '/api/x',
      {
        method: 'OPTIONS',
        headers: { Origin: 'https://app.example.test', 'Access-Control-Request-Method': 'POST' }
      },
      { config: cfg }
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.test');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(calls).toHaveLength(0);
  });

  it('gives a blocked origin no allow-origin on preflight', async () => {
    const res = await call('/api/x', { method: 'OPTIONS', headers: { Origin: 'https://evil.example.test' } }, { config: cfg });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('blocklist', () => {
  const cfg = baseConfig({ blockedOrigins: ['abuse.example.test'] });
  const get = (headers: Record<string, string>, method = 'GET') => call('/api/x', { method, headers }, { config: cfg });

  it('blocks a blocked origin and its subdomains with 403', async () => {
    const calls = stubBackend();
    expect((await get({ Origin: 'https://abuse.example.test' })).status).toBe(403);
    expect((await get({ Origin: 'https://sub.abuse.example.test' })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('blocks by Referer and by cf-worker', async () => {
    stubBackend();
    expect((await get({ Referer: 'https://abuse.example.test/p' })).status).toBe(403);
    expect((await get({ 'cf-worker': 'abuse.example.test' })).status).toBe(403);
  });

  it('does not block a lookalike host', async () => {
    stubBackend();
    expect((await get({ Origin: 'https://notabuse.example.test' })).status).toBe(200);
  });

  it('blocks preflight too', async () => {
    expect((await get({ Origin: 'https://abuse.example.test' }, 'OPTIONS')).status).toBe(403);
  });
});

describe('HMAC routes', () => {
  const path = '/api/secure/data?a=1';

  it('fails closed with 503 and a generic body when no secret is configured', async () => {
    const calls = stubBackend();
    const res = await call(path, { headers: await signed(path) });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['error', 'requestId']);
    expect(body.error).toBe('Service Unavailable');
    expect(calls).toHaveLength(0);
  });

  it('accepts a valid signature (200) and does not forward auth headers', async () => {
    const calls = stubBackend();
    const res = await call(path, { headers: await signed(path) }, withSecret);
    expect(res.status).toBe(200);
    expect(calls[0]!.headers.get('x-auth-token')).toBeNull();
  });

  it('accepts a signed POST body', async () => {
    stubBackend();
    const body = '{"a":1}';
    const res = await call(path, { method: 'POST', body, headers: await signed(path, { method: 'POST', body }) }, withSecret);
    expect(res.status).toBe(200);
  });

  it('400 with an empty body when headers are missing', async () => {
    const res = await call(path, {}, withSecret);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('');
  });

  it('400 on a non-numeric timestamp', async () => {
    const h = await signed(path);
    h['X-Timestamp'] = 'abc';
    expect((await call(path, { headers: h }, withSecret)).status).toBe(400);
  });

  it('401 when the timestamp is outside the window', async () => {
    const h = await signed(path, { ts: Date.now() - 120_000 });
    expect((await call(path, { headers: h }, withSecret)).status).toBe(401);
  });

  it('403 on a wrong secret', async () => {
    stubBackend();
    const h = await signed(path, { secret: 'other' });
    expect((await call(path, { headers: h }, withSecret)).status).toBe(403);
  });

  it('403 when the body does not match the signed hash', async () => {
    const h = await signed(path, { method: 'POST', body: '{"a":1}' });
    expect((await call(path, { method: 'POST', body: '{"a":2}', headers: h }, withSecret)).status).toBe(403);
  });

  it('403 when the path was changed after signing', async () => {
    const h = await signed(path);
    expect((await call('/api/secure/other?a=1', { headers: h }, withSecret)).status).toBe(403);
  });

  it('413 when the body is over 1 MB', async () => {
    const calls = stubBackend();
    const body = 'x'.repeat(1024 * 1024 + 1);
    const res = await call(path, { method: 'POST', body, headers: await signed(path, { method: 'POST', body }) }, withSecret);
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('accepts a body of exactly 1 MB', async () => {
    stubBackend();
    const body = 'x'.repeat(1024 * 1024);
    const res = await call(path, { method: 'POST', body, headers: await signed(path, { method: 'POST', body }) }, withSecret);
    expect(res.status).toBe(200);
  });

  it('rejects a replayed request with 401, also with the same nonce and a new signature', async () => {
    stubBackend();
    const h = await signed(path, { nonce: 'replay-1' });
    expect((await call(path, { headers: h }, withSecret)).status).toBe(200);
    expect((await call(path, { headers: h }, withSecret)).status).toBe(401);
    const h2 = await signed(path, { nonce: 'replay-1', ts: Date.now() + 1 });
    expect((await call(path, { headers: h2 }, withSecret)).status).toBe(401);
  });

  it('a forged request does not burn the real nonce', async () => {
    stubBackend();
    const bad = await signed(path, { nonce: 'burn-1', secret: 'other' });
    expect((await call(path, { headers: bad }, withSecret)).status).toBe(403);
    const good = await signed(path, { nonce: 'burn-1' });
    expect((await call(path, { headers: good }, withSecret)).status).toBe(200);
  });

  it('400 when the nonce contains a pipe', async () => {
    const h = await signed(path);
    h['X-Nonce'] = 'a|b';
    expect((await call(path, { headers: h }, withSecret)).status).toBe(400);
  });

  it('the route outside the HMAC prefix needs no signature', async () => {
    stubBackend();
    expect((await call('/api/open', {}, withSecret)).status).toBe(200);
  });
});

describe('signed X-Device-Id', () => {
  const path = '/api/secure/data';

  it('200 when the device id is signed, and it reaches the backend', async () => {
    const calls = stubBackend();
    const res = await call(path, { headers: await signed(path, { device: 'device-1234' }) }, withSecret);
    expect(res.status).toBe(200);
    expect(calls[0]!.headers.get('x-device-id')).toBe('device-1234');
  });

  it('403 when the device id is sent but not signed', async () => {
    const h = await signed(path, { device: 'device-1234', signDevice: false });
    expect((await call(path, { headers: h }, withSecret)).status).toBe(403);
  });

  it.each(['short', 'bad id!', 'x'.repeat(65)])('400 for malformed id %s', async device => {
    const h = await signed(path);
    h['X-Device-Id'] = device;
    expect((await call(path, { headers: h }, withSecret)).status).toBe(400);
  });
});

describe('admin endpoint', () => {
  const flush = (key?: string): RequestInit => ({ method: 'POST', headers: key ? { 'X-Admin-Key': key } : {} });

  it('401 without a key', async () => {
    expect((await call('/admin/cache-flush', flush(), { envOver: { ADMIN_KEY: 'k' } })).status).toBe(401);
  });

  it('401 with a wrong key', async () => {
    expect((await call('/admin/cache-flush', flush('nope'), { envOver: { ADMIN_KEY: 'k' } })).status).toBe(401);
  });

  it('401 when ADMIN_KEY is not configured, even if a key is sent', async () => {
    expect((await call('/admin/cache-flush', flush('anything'), { envOver: { ADMIN_KEY: undefined } })).status).toBe(401);
  });

  it('200 with the right key', async () => {
    expect((await call('/admin/cache-flush', flush('k'), { envOver: { ADMIN_KEY: 'k' } })).status).toBe(200);
  });
});

describe('error shapes', () => {
  const generic = async (res: Response) => {
    const text = await res.text();
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['error', 'requestId']);
    return text;
  };

  it('503 with only {error, requestId} when the backend is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:443');
      })
    );
    const res = await call('/api/x');
    expect(res.status).toBe(503);
    expect(await generic(res)).not.toContain('ECONNREFUSED');
  });

  it('504 on timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u: unknown, init?: RequestInit) =>
          new Promise((_r, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          })
      )
    );
    const res = await call('/api/x', {}, { envOver: { REQUEST_TIMEOUT: '20' } });
    expect(res.status).toBe(504);
    expect((JSON.parse(await generic(res)) as { error: string }).error).toBe('Gateway Timeout');
  });

  it('500 with a generic body, no stack and no message when something unexpected throws', async () => {
    // Make the first log call throw: it runs inside the handler's try block.
    vi.spyOn(console, 'log').mockImplementationOnce(() => {
      throw new Error('internal detail xyz');
    });
    const res = await call('/nope');
    expect(res.status).toBe(500);
    const text = await generic(res);
    expect(text).not.toMatch(/internal detail|stack/);
  });
});
