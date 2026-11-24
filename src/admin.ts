import { Hono } from 'hono';
import { secureEquals } from './auth';
import { type Env, flushCache, validateConfig } from './config';
import { createLogEntry, log } from './logger';

// Versioned config API. Stored in the existing PROXY_CONFIG KV namespace (no new binding):
//   config            the live config (what the Worker reads)
//   config:meta       { rev }  latest revision number
//   config:rev:<n>    { at, config }  one entry per saved revision, newest MAX_REVS kept
// Every call needs X-Admin-Key (fail closed if ADMIN_KEY is unset). Cloudflare Access can also sit in front
// of /admin/* at the edge (docs/OPERATIONS.md). Single writer assumed: KV is not transactional, so use If-Match.
const MAX_REVS = 20;
const MAX_BODY = 256 * 1024;

interface Rev {
  at: string;
  config: string; // the exact JSON text that was saved
}

const admin = new Hono<{ Bindings: Env }>();

admin.use('*', async (c, next) => {
  const key = c.env.ADMIN_KEY;
  const given = c.req.header('X-Admin-Key');
  if (!key || !given || !(await secureEquals(given, key))) {
    log(createLogEntry(c.req.raw, 401, 0, { error: 'Unauthorized admin attempt' }));
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }
  await next();
});

async function currentRev(env: Env): Promise<number> {
  const meta = (await env.PROXY_CONFIG.get('config:meta', 'json')) as { rev?: number } | null;
  return typeof meta?.rev === 'number' ? meta.rev : 0;
}

/** Save `text` as the next revision and make it live. The caller has already validated it. */
async function save(env: Env, text: string, rev: number): Promise<number> {
  const next = rev + 1;
  const entry: Rev = { at: new Date().toISOString(), config: text };
  await env.PROXY_CONFIG.put(`config:rev:${next}`, JSON.stringify(entry));
  await env.PROXY_CONFIG.put('config', text);
  await env.PROXY_CONFIG.put('config:meta', JSON.stringify({ rev: next }));
  if (next > MAX_REVS) await env.PROXY_CONFIG.delete(`config:rev:${next - MAX_REVS}`);
  flushCache();
  return next;
}

const audit = (c: { req: { raw: Request } }, action: string, extra: Record<string, unknown> = {}) =>
  log(createLogEntry(c.req.raw, 200, 0, { auditType: 'ADMIN_CONFIG', action, ...extra }));

admin.get('/config', async c => {
  const text = await c.env.PROXY_CONFIG.get('config');
  return c.json({ rev: await currentRev(c.env), config: text ? JSON.parse(text) : null });
});

admin.put('/config', async c => {
  const text = await c.req.text();
  if (text.length > MAX_BODY) return c.json({ success: false, message: 'Config too large' }, 413);
  const rev = await currentRev(c.env);
  const ifMatch = c.req.header('If-Match');
  if (ifMatch !== undefined && ifMatch !== String(rev)) {
    return c.json({ success: false, message: `Config changed: current rev is ${rev}`, rev }, 412);
  }
  let warnings: string[];
  try {
    warnings = validateConfig(JSON.parse(text)).warnings;
  } catch (e) {
    return c.json({ success: false, message: e instanceof Error ? e.message : 'Invalid config' }, 400);
  }
  const saved = await save(c.env, text, rev);
  audit(c, 'put', { rev: saved });
  return c.json({ success: true, rev: saved, warnings });
});

admin.get('/config/history', async c => {
  const rev = await currentRev(c.env);
  const items: Array<{ rev: number; at: string }> = [];
  for (let n = rev; n >= 1 && n > rev - MAX_REVS; n--) {
    const e = (await c.env.PROXY_CONFIG.get(`config:rev:${n}`, 'json')) as Rev | null;
    if (e) items.push({ rev: n, at: e.at });
  }
  return c.json({ rev, history: items });
});

admin.post('/config/rollback', async c => {
  const body = (await c.req.json().catch(() => null)) as { rev?: unknown } | null;
  const target = body?.rev;
  if (typeof target !== 'number' || !Number.isInteger(target) || target < 1) {
    return c.json({ success: false, message: 'Body must be {"rev": <number>}' }, 400);
  }
  const old = (await c.env.PROXY_CONFIG.get(`config:rev:${target}`, 'json')) as Rev | null;
  if (!old) return c.json({ success: false, message: `Revision ${target} not found (only the last ${MAX_REVS} are kept)` }, 404);
  try {
    validateConfig(JSON.parse(old.config)); // rules may have tightened since it was saved
  } catch (e) {
    return c.json({ success: false, message: `Revision ${target} no longer validates: ${e instanceof Error ? e.message : ''}` }, 409);
  }
  const saved = await save(c.env, old.config, await currentRev(c.env));
  audit(c, 'rollback', { rev: saved, restoredFrom: target });
  return c.json({ success: true, rev: saved, restoredFrom: target });
});

export default admin;
