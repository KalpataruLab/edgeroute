// Post-deploy smoke test: SMOKE_URL=https://<worker-url> node scripts/smoke.mts
import assert from 'node:assert/strict';

const base = process.env.SMOKE_URL?.replace(/\/$/, '');
if (!base) throw new Error('Set SMOKE_URL to the deployed Worker URL');

const health = await fetch(`${base}/health`);
assert.equal(health.status, 200, 'GET /health');
assert.equal(((await health.json()) as { status: string }).status, 'ok');

const flush = await fetch(`${base}/admin/cache-flush`, { method: 'POST' });
assert.equal(flush.status, 401, 'admin endpoint must reject requests without a key');

console.log(`smoke checks passed for ${base}`);
