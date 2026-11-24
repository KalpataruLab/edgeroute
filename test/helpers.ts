import { env as rawEnv } from 'cloudflare:workers';
import { vi } from 'vitest';
import app from '../src/index';
import { flushCache, type Env, type ProxyConfig } from '../src/config';
import { resetBreakers } from '../src/balancer';
import { resetHealth } from '../src/health';

const env = rawEnv as unknown as Env; // bindings come from wrangler.toml
export const SECRET = 'test-secret';
export const BACKEND = 'https://backend.example.test';

export const baseConfig = (over: Partial<ProxyConfig> = {}): ProxyConfig => ({
  version: '1.0',
  routes: [
    { prefix: '/api/secure', target: `${BACKEND}/secure`, hmacRequired: true },
    { prefix: '/api', target: `${BACKEND}/api`, hmacRequired: false }
  ],
  ...over
});

/** Stub the backend: every outbound fetch is recorded and answered with `reply`. */
export function stubBackend(reply: () => Response = () => new Response('ok', { status: 200 })) {
  const calls: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return reply();
    })
  );
  return calls;
}

/** Store `config` in KV, drop the in-memory cache and send one request through the app. */
export async function call(
  path: string,
  init: RequestInit = {},
  opts: { config?: ProxyConfig; envOver?: Partial<Env>; keepBreakers?: boolean } = {}
): Promise<Response> {
  await env.PROXY_CONFIG.put('config', JSON.stringify(opts.config ?? baseConfig()));
  flushCache();
  if (!opts.keepBreakers) resetBreakers();
  resetHealth();
  const testEnv = { ...env, ...opts.envOver } as Env;
  return app.fetch(new Request(`https://proxy.example.test${path}`, init), testEnv);
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
async function hmac(secret: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}

let counter = 0;
/** Signed headers for a request to `path` (path + query, as the Worker sees it). */
export async function signed(
  path: string,
  o: {
    method?: string;
    body?: string;
    secret?: string;
    nonce?: string;
    device?: string;
    signDevice?: boolean;
    ts?: number;
  } = {}
): Promise<Record<string, string>> {
  const method = o.method ?? 'GET';
  const ts = String(o.ts ?? Date.now());
  const nonce = o.nonce ?? `nonce-${Date.now()}-${counter++}`;
  const ua = 'vitest';
  const bh = o.body ? await sha(o.body) : '';
  const token = await hmac(
    o.secret ?? SECRET,
    `${ts}|${method}|${path}|${bh}|${ua}|${nonce}` + (o.device && o.signDevice !== false ? `|${o.device}` : '')
  );
  const h: Record<string, string> = { 'X-Auth-Token': token, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Body-Hash': bh, 'User-Agent': ua };
  if (o.device) h['X-Device-Id'] = o.device;
  return h;
}
