import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKEND, baseConfig, call, stubBackend } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const APP = 'https://app.example.test';
const wsConfig = (websocket?: boolean) =>
  baseConfig({
    allowedOrigins: [APP],
    routes: [{ prefix: '/ws', target: `${BACKEND}/ws`, hmacRequired: false, ...(websocket === undefined ? {} : { websocket }) }]
  });
const upgrade = {
  Origin: APP,
  Upgrade: 'websocket',
  Connection: 'Upgrade',
  'Sec-WebSocket-Version': '13',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='
};

function backend101() {
  const calls: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      const pair = new WebSocketPair();
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    })
  );
  return calls;
}

describe('WebSocket proxying', () => {
  it('passes the upgrade through on an opted-in route and returns the socket', async () => {
    const calls = backend101();
    const res = await call('/ws/chat', { headers: upgrade }, { config: wsConfig(true) });
    expect(res.status).toBe(101);
    expect((res as unknown as { webSocket: unknown }).webSocket).toBeTruthy();
    expect(calls[0]!.headers.get('Upgrade')).toBe('websocket');
    expect(calls[0]!.headers.get('Sec-WebSocket-Key')).toBe(upgrade['Sec-WebSocket-Key']);
    expect(calls[0]!.url).toBe(`${BACKEND}/ws/chat`);
  });

  it('does not forward Upgrade on a route that did not opt in', async () => {
    const calls = stubBackend();
    const res = await call('/ws/chat', { headers: upgrade }, { config: wsConfig() });
    expect(res.status).toBe(200);
    expect(calls[0]!.headers.has('Upgrade')).toBe(false);
  });

  it('opted-in routes still proxy ordinary requests normally', async () => {
    const calls = stubBackend();
    const res = await call('/ws/chat', {}, { config: wsConfig(true) });
    expect(res.status).toBe(200);
    expect(calls[0]!.headers.has('Upgrade')).toBe(false);
  });

  it('forwards the Origin to the backend on a handshake', async () => {
    const calls = backend101();
    await call('/ws/chat', { headers: upgrade }, { config: wsConfig(true) });
    expect(calls[0]!.headers.get('Origin')).toBe(APP);
  });

  it('rejects a handshake from another origin, including the same host on another scheme or port', async () => {
    backend101();
    for (const origin of ['https://evil.example.test', 'http://app.example.test', 'https://app.example.test:8443']) {
      const res = await call('/ws/chat', { headers: { ...upgrade, Origin: origin } }, { config: wsConfig(true) });
      expect(res.status).toBe(403);
    }
  });

  it('allows a handshake with no Origin (non-browser client)', async () => {
    backend101();
    const { Origin: _o, ...noOrigin } = upgrade;
    const res = await call('/ws/chat', { headers: noOrigin }, { config: wsConfig(true) });
    expect(res.status).toBe(101);
  });

  it.each([
    ['no allowedOrigins anywhere', {}],
    ['a hostname instead of a full origin', { allowedOrigins: ['app.example.test'] }],
    ['a wildcard', { allowedOrigins: ['*.example.test'] }],
    ['an empty route list', { allowedOrigins: [] }]
  ])('refuses a websocket route with %s', async (_n, over) => {
    const { validateConfig } = await import('../src/config');
    expect(() => validateConfig({ routes: [{ prefix: '/ws', target: BACKEND, websocket: true, ...over }] })).toThrow(
      /websocket needs allowedOrigins/
    );
  });

  it('rejects a non-boolean websocket option', async () => {
    const { validateConfig } = await import('../src/config');
    expect(() => validateConfig({ routes: [{ prefix: '/ws', target: BACKEND, websocket: 'yes' }] })).toThrow(
      /websocket must be true or false/
    );
  });
});
