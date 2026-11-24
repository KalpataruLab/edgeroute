import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetReplayCache } from '../src/auth';
import { validateConfig, type ProxyConfig } from '../src/config';
import { SECRET, baseConfig, call, signed, stubBackend } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const path = '/api/secure/data';
const DEV = 'device-aaaa1111';
const envOver = { AUTH_SALT: SECRET };
const withDk = (deviceKeys: NonNullable<ProxyConfig['deviceKeys']>) => ({ config: { ...baseConfig(), deviceKeys }, envOver });

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const b64u = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const enc = new TextEncoder();
async function hmacHex(secret: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const newKey = async () =>
  (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const rawPub = async (k: CryptoKeyPair) => (await crypto.subtle.exportKey('raw', k.publicKey)) as ArrayBuffer;

/** Headers a device would send: public key, the backend's enrollment token for it, and an ECDSA signature. */
async function proof(o: { key?: CryptoKeyPair; enrollFor?: string; device?: string } = {}) {
  const key = o.key ?? (await newKey());
  const pub = b64u(await rawPub(key));
  const device = o.device ?? DEV;
  const base = await signed(path, { device }); // supplies timestamp, nonce, UA and the header names
  const message = `${base['X-Timestamp']}|GET|${path}||${base['User-Agent']}|${base['X-Nonce']}|${device}`;
  const sig = hex(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, enc.encode(message)));
  return {
    ...base,
    'X-Auth-Token': sig,
    'X-Device-Pub': pub,
    'X-Enroll-Token': await hmacHex(SECRET, `enroll:${device}|${o.enrollFor ?? pub}`)
  };
}

describe('device proof of possession', () => {
  it('accepts a signature from the enrolled key in both modes', async () => {
    stubBackend();
    for (const proofMode of ['allowed', 'required'] as const) {
      expect((await call(path, { headers: await proof() }, withDk({ mode: 'optional', proof: proofMode }))).status).toBe(200);
    }
  });

  it('rejects a key the backend never enrolled (token made for another key)', async () => {
    stubBackend();
    const other = b64u(await rawPub(await newKey()));
    const h = await proof({ enrollFor: other });
    expect((await call(path, { headers: h }, withDk({ mode: 'optional', proof: 'allowed' }))).status).toBe(403);
  });

  it('rejects an enrollment token for a different device id', async () => {
    stubBackend();
    const key = await newKey();
    const h = await proof({ key });
    const stolen = await proof({ key, device: 'device-bbbb2222' });
    h['X-Enroll-Token'] = stolen['X-Enroll-Token']!; // enrolled as device B, presented as device A
    expect((await call(path, { headers: h }, withDk({ mode: 'optional', proof: 'allowed' }))).status).toBe(403);
  });

  it('rejects a signature made with a different private key', async () => {
    stubBackend();
    const enrolled = await newKey();
    const h = await proof({ key: enrolled });
    const forged = await proof({ key: await newKey() });
    h['X-Auth-Token'] = forged['X-Auth-Token']!;
    expect((await call(path, { headers: h }, withDk({ mode: 'optional', proof: 'allowed' }))).status).toBe(403);
  });

  it('required: shared and derived HMAC keys no longer work', async () => {
    stubBackend();
    const cfg = withDk({ mode: 'optional', proof: 'required' });
    expect((await call(path, { headers: await signed(path, { device: DEV }) }, cfg)).status).toBe(403);
    expect((await call(path, { headers: await signed(path) }, cfg)).status).toBe(403);
  });

  it('allowed: the existing HMAC methods still work', async () => {
    stubBackend();
    expect(
      (await call(path, { headers: await signed(path, { device: DEV }) }, withDk({ mode: 'optional', proof: 'allowed' }))).status
    ).toBe(200);
  });

  it('is ignored when proof is not configured', async () => {
    stubBackend();
    expect((await call(path, { headers: await proof() }, withDk({ mode: 'optional' }))).status).toBe(403);
    expect((await call(path, { headers: await proof() }, { envOver })).status).toBe(403);
  });

  it('refuses a revoked device and a replay', async () => {
    stubBackend();
    const cfg = withDk({ mode: 'optional', proof: 'allowed', revoked: [DEV] });
    expect((await call(path, { headers: await proof() }, cfg)).status).toBe(403);
    const h = await proof();
    const ok = withDk({ mode: 'optional', proof: 'allowed' });
    expect((await call(path, { headers: h }, ok)).status).toBe(200);
    expect((await call(path, { headers: h }, ok)).status).toBe(401);
  });

  it('strict replay: a malleated signature (r, n - s) is still a replay', async () => {
    stubBackend();
    const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const cfg = {
      config: { ...baseConfig(), strictReplay: true, deviceKeys: { mode: 'optional' as const, proof: 'allowed' as const } },
      envOver
    };
    const h = await proof();
    expect((await call(path, { headers: h }, cfg)).status).toBe(200);
    const sig = h['X-Auth-Token']!;
    const flipped = (N - BigInt(`0x${sig.slice(64)}`)).toString(16).padStart(64, '0');
    resetReplayCache(); // as if the replay reached another instance
    const res = await call(path, { headers: { ...h, 'X-Auth-Token': sig.slice(0, 64) + flipped } }, cfg);
    expect(res.status).toBe(401);
  });

  it('does not forward the proof headers to the backend', async () => {
    const calls = stubBackend();
    await call(path, { headers: await proof() }, withDk({ mode: 'optional', proof: 'allowed' }));
    for (const n of ['x-device-pub', 'x-enroll-token', 'x-auth-token']) expect(calls[0]!.headers.get(n)).toBeNull();
  });

  it('refuses malformed keys and signatures without throwing', async () => {
    stubBackend();
    for (const bad of [{ 'X-Device-Pub': 'not*base64' }, { 'X-Device-Pub': 'AAAA' }, { 'X-Auth-Token': 'zz' }]) {
      const h = { ...(await proof()), ...bad };
      expect((await call(path, { headers: h }, withDk({ mode: 'optional', proof: 'allowed' }))).status).toBe(403);
    }
  });

  it('validates the option', () => {
    expect(() => validateConfig({ ...baseConfig(), deviceKeys: { mode: 'optional', proof: 'yes' } })).toThrow(/deviceKeys\.proof/);
  });
});
