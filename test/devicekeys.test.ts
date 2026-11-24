import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveDeviceKey } from '../src/auth';
import { validateConfig, type ProxyConfig } from '../src/config';
import { SECRET, baseConfig, call, signed, stubBackend } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const path = '/api/secure/data';
const D1 = 'device-aaaa1111';
const D2 = 'device-bbbb2222';
const envOver = { AUTH_SALT: SECRET };
const withMode = (deviceKeys: NonNullable<ProxyConfig['deviceKeys']>) => ({ config: { ...baseConfig(), deviceKeys }, envOver });
const asDevice = async (id: string) => signed(path, { device: id, secret: await deriveDeviceKey(SECRET, id) });

describe('derived device keys', () => {
  it('accepts a request signed with the device key', async () => {
    stubBackend();
    for (const mode of ['optional', 'required'] as const) {
      expect((await call(path, { headers: await asDevice(D1) }, withMode({ mode }))).status).toBe(200);
    }
  });

  it('one device key does not work for another device id', async () => {
    stubBackend();
    const h = await signed(path, { device: D2, secret: await deriveDeviceKey(SECRET, D1) });
    expect((await call(path, { headers: h }, withMode({ mode: 'required' }))).status).toBe(403);
  });

  it('required: the master key no longer works, and a device id is mandatory', async () => {
    stubBackend();
    const master = await signed(path, { device: D1 });
    expect((await call(path, { headers: master }, withMode({ mode: 'required' }))).status).toBe(403);
    const noDevice = await signed(path);
    expect((await call(path, { headers: noDevice }, withMode({ mode: 'required' }))).status).toBe(403);
  });

  it('optional: the master key still works during the transition, with or without a device id', async () => {
    stubBackend();
    expect((await call(path, { headers: await signed(path, { device: D1 }) }, withMode({ mode: 'optional' }))).status).toBe(200);
    expect((await call(path, { headers: await signed(path) }, withMode({ mode: 'optional' }))).status).toBe(200);
  });

  it('refuses a revoked device in either mode, and others still pass', async () => {
    const calls = stubBackend();
    for (const mode of ['optional', 'required'] as const) {
      const cfg = withMode({ mode, revoked: [D1] });
      expect((await call(path, { headers: await asDevice(D1) }, cfg)).status).toBe(403);
      expect((await call(path, { headers: await asDevice(D2) }, cfg)).status).toBe(200);
    }
    expect(calls).toHaveLength(2);
  });

  it('is off without the config: a device-key signature is rejected', async () => {
    stubBackend();
    expect((await call(path, { headers: await asDevice(D1) }, { envOver })).status).toBe(403);
  });

  it('works with a rotated key id: the device key derives from that key', async () => {
    stubBackend();
    const keys = JSON.stringify({ k2: 'second-secret' });
    const h = await signed(path, { device: D1, secret: await deriveDeviceKey('second-secret', D1) });
    h['X-Key-Id'] = 'k2';
    expect(
      (await call(path, { headers: h }, { config: { ...baseConfig(), deviceKeys: { mode: 'required' } }, envOver: { AUTH_KEYS: keys } }))
        .status
    ).toBe(200);
  });
});

describe('deviceKeys validation', () => {
  it.each([
    ['unknown mode', { mode: 'on' }],
    ['no mode', {}],
    ['revoked not an array', { mode: 'optional', revoked: 'x' }],
    ['revoked id too short', { mode: 'optional', revoked: ['abc'] }]
  ])('rejects %s', (_n, deviceKeys) => {
    expect(() => validateConfig({ ...baseConfig(), deviceKeys })).toThrow(/Invalid config: deviceKeys/);
  });
});
