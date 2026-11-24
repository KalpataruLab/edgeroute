import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseConfig, call, stubBackend } from './helpers';

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

describe('X-Request-Id', () => {
  it('uses a valid incoming ID: forwarded, returned and logged', async () => {
    const calls = stubBackend();
    const res = await call('/api/x', { headers: { 'X-Request-Id': 'abc-123_XYZ.1' } });
    expect(res.headers.get('X-Request-Id')).toBe('abc-123_XYZ.1');
    expect(calls[0]!.headers.get('X-Request-Id')).toBe('abc-123_XYZ.1');
    expect(lines[0]!.requestId).toBe('abc-123_XYZ.1');
  });

  it('generates one when none is sent, and it matches everywhere', async () => {
    const calls = stubBackend();
    const res = await call('/api/x');
    const id = res.headers.get('X-Request-Id');
    expect(id).toBeTruthy();
    expect(calls[0]!.headers.get('X-Request-Id')).toBe(id);
    expect(lines[0]!.requestId).toBe(id);
  });

  it('replaces an unsafe or oversized incoming ID', async () => {
    stubBackend();
    for (const bad of ['has space', 'x'.repeat(65), 'a"b', '']) {
      const res = await call('/api/x', { headers: { 'X-Request-Id': bad } });
      const id = res.headers.get('X-Request-Id')!;
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    }
  });

  it('overrides an ID set by the backend', async () => {
    stubBackend(() => new Response('ok', { headers: { 'X-Request-Id': 'from-backend' } }));
    const res = await call('/api/x', { headers: { 'X-Request-Id': 'mine-1' } });
    expect(res.headers.get('X-Request-Id')).toBe('mine-1');
  });

  it('is on error responses, in the body and in the log', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      })
    );
    const res = await call('/api/x', { headers: { 'X-Request-Id': 'err-1' } });
    expect(res.status).toBe(503);
    expect(res.headers.get('X-Request-Id')).toBe('err-1');
    expect(((await res.json()) as { requestId: string }).requestId).toBe('err-1');
    expect(lines.every(l => l.requestId === 'err-1')).toBe(true);
  });

  it('is on a 404 and on the log line', async () => {
    const res = await call('/nope', { headers: { 'X-Request-Id': 'nf-1' } }, { config: baseConfig({ routes: [] }) });
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Request-Id')).toBe('nf-1');
    expect(lines[0]!.requestId).toBe('nf-1');
  });
});
