import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthKeys } from '../src/config';
import { call, signed, stubBackend } from './helpers';

const path = '/api/secure/data';
const keys = JSON.stringify({ k1: 'secret-one', k2: 'secret-two' });

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const withKey = async (id: string | null, secret: string) => {
  const h = await signed(path, { secret });
  if (id !== null) h['X-Key-Id'] = id;
  return h;
};

describe('HMAC key rotation (X-Key-Id)', () => {
  const env = { envOver: { AUTH_SALT: 'default-secret', AUTH_KEYS: keys } };

  it('verifies with the named key, and does not forward X-Key-Id', async () => {
    const calls = stubBackend();
    expect((await call(path, { headers: await withKey('k2', 'secret-two') }, env)).status).toBe(200);
    expect(calls[0]!.headers.get('x-key-id')).toBeNull();
  });

  it('old and new keys work side by side, and the default key still works without an id', async () => {
    stubBackend();
    expect((await call(path, { headers: await withKey('k1', 'secret-one') }, env)).status).toBe(200);
    expect((await call(path, { headers: await withKey('k2', 'secret-two') }, env)).status).toBe(200);
    expect((await call(path, { headers: await withKey(null, 'default-secret') }, env)).status).toBe(200);
  });

  it('403 when the id names one key but the request is signed with another', async () => {
    expect((await call(path, { headers: await withKey('k1', 'secret-two') }, env)).status).toBe(403);
  });

  it('403 for an unknown id, including prototype names', async () => {
    for (const id of ['nope', 'constructor', '__proto__']) {
      expect((await call(path, { headers: await withKey(id, 'default-secret') }, env)).status).toBe(403);
    }
  });

  it('a revoked key (removed from AUTH_KEYS) is rejected while others keep working', async () => {
    stubBackend();
    const only2 = { envOver: { AUTH_SALT: 'default-secret', AUTH_KEYS: JSON.stringify({ k2: 'secret-two' }) } };
    expect((await call(path, { headers: await withKey('k1', 'secret-one') }, only2)).status).toBe(403);
    expect((await call(path, { headers: await withKey('k2', 'secret-two') }, only2)).status).toBe(200);
  });

  it('works with named keys only; an unsigned-id request is then refused', async () => {
    stubBackend();
    const keysOnly = { envOver: { AUTH_KEYS: keys } };
    expect((await call(path, { headers: await withKey('k1', 'secret-one') }, keysOnly)).status).toBe(200);
    expect((await call(path, { headers: await withKey(null, 'secret-one') }, keysOnly)).status).toBe(403);
  });

  it('still fails closed with 503 when neither AUTH_SALT nor AUTH_KEYS is set', async () => {
    expect((await call(path, { headers: await withKey('k1', 'secret-one') })).status).toBe(503);
  });

  it('a malformed AUTH_KEYS is ignored, not fatal', () => {
    expect(getAuthKeys({ AUTH_KEYS: '{oops' } as never)).toEqual({});
    expect(getAuthKeys({ AUTH_KEYS: JSON.stringify({ a: 1, b: '', c: 'ok' }) } as never)).toEqual({ c: 'ok' });
  });
});

describe('metrics', () => {
  const dataset = () => {
    const points: unknown[] = [];
    return {
      points,
      writeDataPoint: (p: unknown) => {
        points.push(p);
      }
    };
  };

  it('writes one data point per proxied request and per rejection', async () => {
    stubBackend();
    const m = dataset();
    await call('/api/x', {}, { envOver: { METRICS: m as never } });
    await call('/nope', {}, { envOver: { METRICS: m as never } });
    expect(m.points).toHaveLength(2);
    expect(m.points[0]).toMatchObject({
      blobs: ['/api', 'GET', '', 'https://backend.example.test/api/x', ''],
      doubles: [200, expect.any(Number)]
    });
    expect(m.points[1]).toMatchObject({ doubles: [404, expect.any(Number)] });
  });

  it('records the audit type for HMAC failures', async () => {
    const m = dataset();
    await call(path, { headers: await signed(path, { secret: 'x' }) }, { envOver: { AUTH_SALT: 's', METRICS: m as never } });
    expect(m.points[0]).toMatchObject({ blobs: ['/api/secure', 'GET', 'HMAC_VERIFICATION_FAILED', '', ''] });
  });

  it('does not fail the request when the dataset throws, or is missing', async () => {
    stubBackend();
    const bad = {
      writeDataPoint: () => {
        throw new Error('boom');
      }
    };
    expect((await call('/api/x', {}, { envOver: { METRICS: bad as never } })).status).toBe(200);
    expect((await call('/api/x', {}, { envOver: { METRICS: undefined } })).status).toBe(200);
  });
});
