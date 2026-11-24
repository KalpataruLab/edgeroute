import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetReplayCache } from '../src/auth';
import { validateConfig, type Env } from '../src/config';
import { SECRET, baseConfig, call, signed, stubBackend } from './helpers';

const env = rawEnv as unknown as Env;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const path = '/api/secure/data';
const envOver = { AUTH_SALT: SECRET };
const strict = { config: { ...baseConfig(), strictReplay: true }, envOver };

describe('strict replay protection', () => {
  it('rejects a replay that reaches another instance (memory cache empty)', async () => {
    stubBackend();
    const h = await signed(path);
    expect((await call(path, { headers: h }, strict)).status).toBe(200);
    resetReplayCache(); // as if the second request landed on a different Worker instance
    expect((await call(path, { headers: h }, strict)).status).toBe(401);
  });

  it('without strictReplay the same cross-instance replay is accepted (the documented limit)', async () => {
    stubBackend();
    const h = await signed(path);
    expect((await call(path, { headers: h }, { envOver })).status).toBe(200);
    resetReplayCache();
    expect((await call(path, { headers: h }, { envOver })).status).toBe(200);
  });

  it('different requests are not affected', async () => {
    stubBackend();
    for (let i = 0; i < 5; i++) expect((await call(path, { headers: await signed(path) }, strict)).status).toBe(200);
  });

  it('a forged request does not burn the real token', async () => {
    stubBackend();
    const good = await signed(path);
    const forged = { ...good, 'X-Auth-Token': good['X-Auth-Token']!.replace(/.$/, c => (c === '0' ? '1' : '0')) };
    expect((await call(path, { headers: forged }, strict)).status).toBe(403);
    resetReplayCache();
    expect((await call(path, { headers: good }, strict)).status).toBe(200);
  });

  it('fails closed (nothing is proxied) when the REPLAY binding is missing', async () => {
    const calls = stubBackend();
    const res = await call(path, { headers: await signed(path) }, { ...strict, envOver: { ...envOver, REPLAY: undefined } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(calls).toHaveLength(0);
  });

  it('the object expires entries after their window', async () => {
    const stub = env.REPLAY!.get(env.REPLAY!.idFromName('shard-t')) as unknown as { claim(k: string, t: number): Promise<boolean> };
    expect(await stub.claim('k1', 300)).toBe(true);
    expect(await stub.claim('k1', 300)).toBe(false);
    await new Promise(r => setTimeout(r, 400));
    expect(await stub.claim('k1', 300)).toBe(true);
  });

  it('keeps a claim live for the whole window and purges expired entries', async () => {
    const id = env.REPLAY!.idFromName('shard-p');
    const stub = env.REPLAY!.get(id) as unknown as { claim(k: string, t: number): Promise<boolean> };
    for (let i = 0; i < 30; i++) expect(await stub.claim(`p${i}`, 50)).toBe(true);
    await new Promise(r => setTimeout(r, 120));
    // expired entries can be claimed again; a fresh claim before expiry cannot
    expect(await stub.claim('p0', 10_000)).toBe(true);
    expect(await stub.claim('p0', 10_000)).toBe(false);
  });

  it('validates the option', () => {
    expect(() => validateConfig({ ...baseConfig(), strictReplay: 'yes' })).toThrow(/strictReplay/);
    expect(() => validateConfig({ ...baseConfig(), strictReplay: true })).not.toThrow();
  });
});
