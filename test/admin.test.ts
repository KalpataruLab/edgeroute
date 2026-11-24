import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { flushCache, type Env } from '../src/config';
import app from '../src/index';
import { baseConfig } from './helpers';

const env = { ...(rawEnv as unknown as Env), ADMIN_KEY: 'adm' } as Env;
const KV = env.PROXY_CONFIG;
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'X-Admin-Key': 'adm' }) =>
  app.fetch(
    new Request(`https://proxy.example.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    }),
    env
  );
const json = async (r: Response) =>
  (await r.json()) as { rev: number; message: string; history: { rev: number }[]; config: { version: string } };

async function clean() {
  for (const k of (await KV.list({ prefix: 'config' })).keys) await KV.delete(k.name);
  flushCache();
}
const cfg = (v: string) => ({ ...baseConfig(), version: v });

describe('admin config API', () => {
  it('needs the admin key on every endpoint, and is closed without ADMIN_KEY', async () => {
    for (const [m, p] of [
      ['GET', '/admin/config'],
      ['PUT', '/admin/config'],
      ['GET', '/admin/config/history'],
      ['POST', '/admin/config/rollback']
    ]) {
      const b = m === 'GET' ? undefined : '{}';
      expect((await send(m!, p!, b, {})).status).toBe(401);
      expect((await send(m!, p!, b, { 'X-Admin-Key': 'wrong' })).status).toBe(401);
    }
    const closed = await app.fetch(new Request('https://proxy.example.test/admin/config', { headers: { 'X-Admin-Key': 'x' } }), {
      ...env,
      ADMIN_KEY: undefined
    } as Env);
    expect(closed.status).toBe(401);
  });

  it('saves a valid config as a new revision and makes it live', async () => {
    await clean();
    const res = await send('PUT', '/admin/config', cfg('a'));
    expect(res.status).toBe(200);
    expect((await json(res)).rev).toBe(1);
    expect(JSON.parse((await KV.get('config')) as string).version).toBe('a');
    const got = await json(await send('GET', '/admin/config'));
    expect(got.rev).toBe(1);
    expect(got.config.version).toBe('a');
  });

  it('rejects an invalid config and keeps the live one', async () => {
    await clean();
    await send('PUT', '/admin/config', cfg('good'));
    const bad = await send('PUT', '/admin/config', { routes: [{ prefix: 'nope', target: 'http://x' }] });
    expect(bad.status).toBe(400);
    expect((await json(bad)).message).toMatch(/Invalid config/);
    expect((await send('PUT', '/admin/config', 'not json')).status).toBe(400);
    expect(JSON.parse((await KV.get('config')) as string).version).toBe('good');
    expect((await json(await send('GET', '/admin/config'))).rev).toBe(1);
  });

  it('If-Match refuses a stale revision', async () => {
    await clean();
    await send('PUT', '/admin/config', cfg('a'));
    const stale = await send('PUT', '/admin/config', cfg('b'), { 'X-Admin-Key': 'adm', 'If-Match': '0' });
    expect(stale.status).toBe(412);
    const ok = await send('PUT', '/admin/config', cfg('b'), { 'X-Admin-Key': 'adm', 'If-Match': '1' });
    expect((await json(ok)).rev).toBe(2);
  });

  it('lists history newest first and rolls back as a new revision', async () => {
    await clean();
    for (const v of ['a', 'b', 'c']) await send('PUT', '/admin/config', cfg(v));
    const h = await json(await send('GET', '/admin/config/history'));
    expect(h.history.map((x: { rev: number }) => x.rev)).toEqual([3, 2, 1]);
    const rb = await json(await send('POST', '/admin/config/rollback', { rev: 1 }));
    expect(rb).toMatchObject({ success: true, rev: 4, restoredFrom: 1 });
    expect(JSON.parse((await KV.get('config')) as string).version).toBe('a');
  });

  it('rollback validates its input and the revision must exist', async () => {
    await clean();
    await send('PUT', '/admin/config', cfg('a'));
    expect((await send('POST', '/admin/config/rollback', { rev: 'x' })).status).toBe(400);
    expect((await send('POST', '/admin/config/rollback', { rev: 99 })).status).toBe(404);
  });

  it('keeps only the last 20 revisions', async () => {
    await clean();
    for (let i = 1; i <= 22; i++) await send('PUT', '/admin/config', cfg(String(i)));
    expect(await KV.get('config:rev:1')).toBeNull();
    expect(await KV.get('config:rev:2')).toBeNull();
    expect(await KV.get('config:rev:3')).not.toBeNull();
    expect((await send('POST', '/admin/config/rollback', { rev: 1 })).status).toBe(404);
  });

  it('refuses a config over 256 KB', async () => {
    await clean();
    expect((await send('PUT', '/admin/config', 'x'.repeat(300 * 1024))).status).toBe(413);
  });
});
