/**
 * Stronger HMAC verification with:
 * - HMAC-SHA256 (not simple SHA)
 * - Includes: timestamp + method + path + bodyHash + userAgent
 * - Nonce replay check: best-effort, per-isolate memory (no KV)
 * - Shorter expiry (30s default)
 */

interface HMACVerificationResult {
  valid: boolean;
  reason?: string;
  statusCode?: number; // HTTP status code for the failure (400/401/403)
  deviceId?: string; // optional X-Device-Id (audit only), set once its format is valid
}

/**
 * Generate HMAC-SHA256
 */
async function generateHMAC(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(message);

  // Import key for HMAC
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

  // Generate HMAC
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);

  // Convert to hex
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison (length is not secret: both are hex digests)
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Constant-time equality for secrets of any length (hashes both sides first).
 */
export async function secureEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha),
    y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Per-device signing key: HMAC(master secret, "device:" + id), as lowercase hex. The backend derives it after login. */
export function deriveDeviceKey(secret: string, deviceId: string): Promise<string> {
  return generateHMAC(secret, `device:${deviceId}`);
}

export interface DeviceKeyPolicy {
  mode: 'optional' | 'required'; // optional: legacy master-key signatures still pass (transition); required: derived keys only
  revoked?: string[];
  proof?: 'allowed' | 'required'; // allowed: a request may prove possession of an enrolled key; required: only that
}

/**
 * Hash request body (for body integrity)
 */
async function hashBody(body: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', body);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ponytail: per-isolate memory only; replays across isolates/PoPs inside the window
// are not caught. Upgrade to a Durable Object if strict one-time nonces are needed.
// A token is accepted up to windowMs after its timestamp, and that timestamp may be windowMs ahead of the clock,
// so one use must be remembered for 2 x windowMs. The slack covers clock skew between the Worker and the Durable Object.
const REPLAY_SLACK_MS = 5000;
const MAX_SIGNED_BODY = 1024 * 1024; // 1 MB
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const seenNonces = new Map<string, number>(); // "n:nonce" and "t:token" -> expiry (ms)

/** Test hook: forget the in-memory replay cache, as if the request reached another instance. */
export function resetReplayCache(): void {
  seenNonces.clear();
}

const b64uToBytes = (s: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
  } catch {
    return null;
  }
};

/** Verify an ECDSA P-256 / SHA-256 signature (hex, 64 bytes r||s) made with the public key `pub` (base64url, raw 65-byte point). */
async function verifyEcdsa(pub: string, sigHex: string, message: string): Promise<boolean> {
  const raw = b64uToBytes(pub);
  if (raw?.length !== 65 || raw[0] !== 4 || !/^[0-9a-f]{128}$/.test(sigHex)) return false;
  try {
    const key = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const sig = Uint8Array.from(sigHex.match(/../g) ?? [], h => Number.parseInt(h, 16));
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

/**
 * Verify stronger HMAC token with nonce protection
 */
export async function verifyStrongerHMAC(
  request: Request,
  secret: string,
  windowMs: number = 30000, // 30 seconds
  devices?: DeviceKeyPolicy,
  strict?: { claim(token: string, ttlMs: number): Promise<boolean> } // shared one-time check (see replay.ts)
): Promise<HMACVerificationResult> {
  // 1. Extract headers
  const token = request.headers.get('X-Auth-Token');
  const timestampStr = request.headers.get('X-Timestamp');
  const nonce = request.headers.get('X-Nonce');
  const bodyHashHeader = request.headers.get('X-Body-Hash');

  if (!token || !timestampStr || !nonce) {
    return { valid: false, reason: 'Missing required headers', statusCode: 400 };
  }
  // '|' separates the signed fields; a nonce containing it could shift field boundaries.
  if (nonce.includes('|')) {
    return { valid: false, reason: 'Invalid nonce', statusCode: 400 };
  }

  // 1b. Optional device ID: signed when present, for per-device audit logs.
  // It is NOT authentication: every client shares one secret, so any holder can claim any ID.
  const deviceHeader = request.headers.get('X-Device-Id');
  if (deviceHeader !== null && !DEVICE_ID_RE.test(deviceHeader)) {
    return { valid: false, reason: 'Invalid device id', statusCode: 400 };
  }
  const deviceId = deviceHeader ?? undefined;
  if (devices) {
    if (deviceId && devices.revoked?.includes(deviceId)) return { valid: false, reason: 'Device revoked', statusCode: 403, deviceId };
    if (devices.proof === 'required' && !request.headers.get('X-Device-Pub'))
      return { valid: false, reason: 'Device proof required', statusCode: 403, deviceId };
    if (!deviceId && devices.mode === 'required') return { valid: false, reason: 'Device id required', statusCode: 403 };
  }

  // 2. Validate timestamp (prevent old requests)
  const timestamp = parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp)) {
    return { valid: false, reason: 'Invalid timestamp', statusCode: 400 };
  }

  const now = Date.now();
  const age = Math.abs(now - timestamp);
  if (age > windowMs) {
    return { valid: false, reason: `Token expired (age: ${age}ms, window: ${windowMs}ms)`, statusCode: 401, deviceId };
  }

  // 3. Check replay (best-effort, in memory). Keyed on the signature, not the nonce header:
  // the same signed string always has the same token, so re-sending it with shifted
  // header boundaries (different nonce / UA split) cannot dodge the check.
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  const keys = [`n:${nonce}`, `t:${token}`];
  if (keys.some(k => seenNonces.has(k))) {
    return { valid: false, reason: 'Nonce already used (replay attack)', statusCode: 401, deviceId };
  }
  // Reserve now (no await since has()), so parallel requests in this isolate can't both pass.
  // Released on any failure below so a forged request can't burn a real nonce or token.
  for (const k of keys) seenNonces.set(k, now + windowMs * 2);
  const fail = (reason: string, statusCode: number): HMACVerificationResult => {
    for (const k of keys) seenNonces.delete(k);
    return { valid: false, reason, statusCode, deviceId };
  };

  // 3b. Verify the body hash against the real body (header alone is attacker-controlled)
  // ponytail: whole body is buffered, capped at MAX_SIGNED_BODY; stream-hash if larger bodies are needed
  const declaredLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declaredLength > MAX_SIGNED_BODY) {
    return fail('Body too large to verify', 413);
  }
  // No body (the usual GET/HEAD case): the hash is the empty string, so skip the clone and the read.
  let actualBodyHash = '';
  if (request.body !== null) {
    const bodyBuf = await request.clone().arrayBuffer();
    if (bodyBuf.byteLength > MAX_SIGNED_BODY) {
      return fail('Body too large to verify', 413);
    }
    actualBodyHash = bodyBuf.byteLength ? await hashBody(bodyBuf) : '';
  }
  if (!timingSafeEqual(bodyHashHeader || '', actualBodyHash)) {
    return fail('Body hash mismatch', 403);
  }

  // 4. Reconstruct message
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname + url.search;
  const userAgent = request.headers.get('User-Agent') || '';

  // Message format: timestamp|method|path|bodyHash|userAgent|nonce[|deviceId]
  // (|deviceId is appended only when the header is sent, so existing clients are unchanged)
  const message = `${timestampStr}|${method}|${path}|${bodyHashHeader || ''}|${userAgent}|${nonce}` + (deviceId ? `|${deviceId}` : '');

  // Last step for every method: in strict mode claim the verified token in the shared store (fail closed if it cannot be reached).
  const finish = async (claimKey: string): Promise<HMACVerificationResult> => {
    if (strict) {
      let first: boolean;
      try {
        first = await strict.claim(claimKey, windowMs * 2 + REPLAY_SLACK_MS);
      } catch {
        return fail('Replay check unavailable', 503);
      }
      if (!first) return fail('Nonce already used (replay attack)', 401);
    }

    return { valid: true, deviceId };
  };

  // 5a. Proof of possession: the backend vouched for this device's public key with an enrollment token, and the
  // request is signed with the matching private key, which never leaves the device.
  const pub = request.headers.get('X-Device-Pub');
  if (pub && devices?.proof) {
    if (!deviceId) return fail('Device id required', 403);
    const enrolled = request.headers.get('X-Enroll-Token') ?? '';
    if (!timingSafeEqual(enrolled, await generateHMAC(secret, `enroll:${deviceId}|${pub}`))) return fail('Invalid enrollment', 403);
    if (!(await verifyEcdsa(pub, token, message))) return fail('Invalid proof signature', 403);
    // ECDSA signatures are malleable ((r, s) and (r, n - s) both verify), so the signature is NOT a stable replay key here.
    // Claim the signed device id and nonce instead: neither can change without breaking the signature.
    return finish(`p:${deviceId}|${nonce}`);
  }

  // 5. Calculate expected HMAC
  // Device keys: a device signs with its own derived key; in optional mode the master key still works.
  let expectedToken: string;
  if (devices && deviceId) {
    expectedToken = await generateHMAC(await deriveDeviceKey(secret, deviceId), message);
    if (devices.mode === 'optional' && !timingSafeEqual(token, expectedToken)) {
      expectedToken = await generateHMAC(secret, message);
    }
  } else {
    expectedToken = await generateHMAC(secret, message);
  }

  // 6. Timing-safe comparison (constant-time)
  if (!timingSafeEqual(token, expectedToken)) {
    return fail('Invalid HMAC signature', 403);
  }

  return finish(token); // HMAC is deterministic: the same message always gives the same token
}
