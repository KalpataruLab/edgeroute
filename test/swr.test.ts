import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushCache, getConfig, type Env } from '../src/config';

const cfg = (target: string) => JSON.stringify({ routes: [{ prefix: '/', target, hmacRequired: false }], version: '1' });
const A = 'https://a.example.test';
const B = 'https://b.example.test';

function fakeEnv(values: string[]) {
  const get = vi.fn(async () => values.shift() ?? null);
  return { env: { PROXY_CONFIG: { get }, CACHE_TTL: '1000' } as unknown as Env, get };
}
function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      }
    },
    done: () => Promise.all(pending)
  };
}

let now = 1_000_000;
beforeEach(() => {
  flushCache();
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

describe('stale-while-revalidate config cache', () => {
  it('serves the cached copy at once when stale and refreshes in the background', async () => {
    const { env, get } = fakeEnv([cfg(A), cfg(B)]);
    const { ctx, done } = fakeCtx();
    expect((await getConfig(env, ctx)).routes[0]!.target).toBe(A); // cold: waits for KV
    now += 1001; // expired
    expect((await getConfig(env, ctx)).routes[0]!.target).toBe(A); // stale copy, no wait
    await done();
    expect(get).toHaveBeenCalledTimes(2);
    expect((await getConfig(env, ctx)).routes[0]!.target).toBe(B); // refreshed copy is now fresh
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('a burst of stale requests triggers one KV read', async () => {
    const { env, get } = fakeEnv([cfg(A), cfg(B)]);
    const { ctx, done } = fakeCtx();
    await getConfig(env, ctx);
    now += 1001;
    await Promise.all([getConfig(env, ctx), getConfig(env, ctx), getConfig(env, ctx)]);
    await done();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('waits for KV when there is no execution context', async () => {
    const { env } = fakeEnv([cfg(A), cfg(B)]);
    await getConfig(env);
    now += 1001;
    expect((await getConfig(env)).routes[0]!.target).toBe(B);
  });

  it('keeps serving the stale copy when the background refresh fails', async () => {
    const { env, get } = fakeEnv([cfg(A)]);
    const { ctx, done } = fakeCtx();
    await getConfig(env, ctx);
    get.mockRejectedValueOnce(new Error('kv down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    now += 1001;
    expect((await getConfig(env, ctx)).routes[0]!.target).toBe(A);
    await done();
    expect((await getConfig(env, ctx)).routes[0]!.target).toBe(A);
  });
});
