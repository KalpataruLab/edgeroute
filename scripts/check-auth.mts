// Run: node scripts/check-auth.mts   (Node 22.6+; self-check for HMAC + secureEquals)
import assert from 'node:assert/strict';
import { verifyStrongerHMAC, secureEquals } from '../src/auth.ts';

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
async function sign(secret: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}
async function req(secret: string, body: string, nonce: string, tamper = false, device?: string, signDevice = true) {
  const ts = String(Date.now()),
    ua = 'test',
    url = 'https://x.test/api/data?a=1';
  const bh = body ? await sha(body) : '';
  const token = await sign(secret, `${ts}|POST|/api/data?a=1|${bh}|${ua}|${nonce}` + (device && signDevice ? `|${device}` : ''));
  const headers: Record<string, string> = {
    'X-Auth-Token': token,
    'X-Timestamp': ts,
    'X-Nonce': nonce,
    'X-Body-Hash': bh,
    'User-Agent': ua
  };
  if (device) headers['X-Device-Id'] = device;
  return new Request(url, { method: 'POST', body: tamper ? body + 'x' : body || undefined, headers });
}

assert.equal((await verifyStrongerHMAC(await req('s', '{"a":1}', 'n1'), 's')).valid, true);
assert.equal((await verifyStrongerHMAC(await req('s', '{"a":1}', 'n1'), 's')).valid, false, 'replay in same isolate');
assert.equal((await verifyStrongerHMAC(await req('s', '{"a":1}', 'n2', true), 's')).valid, false, 'tampered body');
assert.equal((await verifyStrongerHMAC(await req('wrong', '', 'n3'), 's')).valid, false, 'wrong secret');
assert.equal((await verifyStrongerHMAC(await req('s', '', 'n4'), 's')).valid, true, 'empty body');
const d = await verifyStrongerHMAC(await req('s', '', 'n5', false, 'device-1234'), 's');
assert.equal(d.valid, true, 'signed device id');
assert.equal(d.deviceId, 'device-1234');
assert.equal((await verifyStrongerHMAC(await req('s', '', 'n6', false, 'device-1234', false), 's')).valid, false, 'device id not signed');
const bad = await verifyStrongerHMAC(await req('s', '', 'n7', false, 'bad id!'), 's');
assert.equal(bad.valid, false, 'malformed device id');
assert.equal(bad.statusCode, 400);
assert.equal(
  (await verifyStrongerHMAC(await req('wrong', '', 'n8', false, 'device-1234'), 's')).deviceId,
  'device-1234',
  'failure keeps device id for logs'
);
assert.equal((await verifyStrongerHMAC(await req('s', '', 'bad|nonce'), 's')).statusCode, 400, 'nonce with pipe');
// Shifted boundaries: ua|n9|dev... signed as UA "test|n9", nonce "device-1234", no device header.
{
  const ts = String(Date.now()),
    msg = `${ts}|POST|/api/data?a=1||test|n9|device-1234`;
  const tok = await sign('s', msg);
  const mk = (ua: string, nonce: string, dev?: string) =>
    new Request('https://x.test/api/data?a=1', {
      method: 'POST',
      headers: {
        'X-Auth-Token': tok,
        'X-Timestamp': ts,
        'X-Nonce': nonce,
        'X-Body-Hash': '',
        'User-Agent': ua,
        ...(dev ? { 'X-Device-Id': dev } : {})
      }
    });
  assert.equal((await verifyStrongerHMAC(mk('test', 'n9', 'device-1234'), 's')).valid, true, 'original');
  assert.equal((await verifyStrongerHMAC(mk('test|n9', 'device-1234'), 's')).valid, false, 'shifted fields replay');
}
assert.equal(await secureEquals('abc', 'abc'), true);
assert.equal(await secureEquals('abc', 'abcd'), false);
console.log('auth checks passed');
