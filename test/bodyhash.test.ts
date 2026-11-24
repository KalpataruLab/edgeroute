import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECRET, call, signed, stubBackend } from './helpers';

const withSecret = { envOver: { AUTH_SALT: SECRET } };
const path = '/api/secure/x';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('body hashing', () => {
  it('a bodyless GET is verified without cloning or reading the request', async () => {
    stubBackend();
    const clone = vi.spyOn(Request.prototype, 'clone');
    const res = await call(path, { headers: await signed(path) }, withSecret);
    expect(res.status).toBe(200);
    expect(clone).not.toHaveBeenCalled();
  });

  it('a bodyless GET that claims a body hash is still rejected (403)', async () => {
    stubBackend();
    const h = await signed(path, { body: 'pretend' }); // header says there is a body, the request has none
    expect((await call(path, { headers: h }, withSecret)).status).toBe(403);
  });

  it('a POST body is still hashed and verified', async () => {
    stubBackend();
    const body = '{"a":1}';
    const ok = await call(path, { method: 'POST', body, headers: await signed(path, { method: 'POST', body }) }, withSecret);
    expect(ok.status).toBe(200);
    const bad = await call(path, { method: 'POST', body: 'tampered', headers: await signed(path, { method: 'POST', body }) }, withSecret);
    expect(bad.status).toBe(403);
  });
});
