import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logSuccess, type LogEntry } from '../src/logger';
import { SECRET, call, signed, stubBackend } from './helpers';

const withSecret = { AUTH_SALT: SECRET };
let lines: Record<string, unknown>[];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => {
    lines.push(JSON.parse(s));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('one log line per authenticated request', () => {
  it('folds AUTH_SUCCESS into the proxied line', async () => {
    stubBackend();
    const path = '/api/secure/x';
    const res = await call(path, { headers: await signed(path, { device: 'device-1234' }) }, { envOver: withSecret });
    expect(res.status).toBe(200);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      auditType: 'AUTH_SUCCESS',
      hmacVerified: true,
      status: 200,
      deviceId: 'device-1234',
      matchedPrefix: '/api/secure'
    });
  });

  it('an unauthenticated route has no auth fields', async () => {
    stubBackend();
    await call('/api/x');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.auditType).toBeUndefined();
  });
});

describe('LOG_SUCCESS_SAMPLE', () => {
  const entry = (status: number) => ({ status }) as LogEntry;

  it('logs everything by default', () => {
    logSuccess(entry(200), {}, () => 0.99);
    logSuccess(entry(200), { LOG_SUCCESS_SAMPLE: '' }, () => 0.99);
    expect(lines).toHaveLength(2);
  });

  it('keeps the configured share of successes and always logs failures', () => {
    logSuccess(entry(200), { LOG_SUCCESS_SAMPLE: '0.1' }, () => 0.05); // kept
    logSuccess(entry(200), { LOG_SUCCESS_SAMPLE: '0.1' }, () => 0.5); // dropped
    logSuccess(entry(502), { LOG_SUCCESS_SAMPLE: '0' }, () => 0.5); // failure: always
    expect(lines.map(l => l.status)).toEqual([200, 502]);
  });

  it('a bad value falls back to logging everything', () => {
    logSuccess(entry(200), { LOG_SUCCESS_SAMPLE: 'abc' }, () => 0.9);
    logSuccess(entry(200), { LOG_SUCCESS_SAMPLE: '-1' }, () => 0.9);
    expect(lines).toHaveLength(2);
  });

  it('end to end: 0 drops the success line, a backend failure is still logged', async () => {
    stubBackend();
    await call('/api/x', {}, { envOver: { LOG_SUCCESS_SAMPLE: '0' } });
    expect(lines).toHaveLength(0);
    stubBackend(() => new Response('bad', { status: 500 }));
    await call('/api/x', {}, { envOver: { LOG_SUCCESS_SAMPLE: '0' } });
    expect(lines).toHaveLength(1);
  });
});
