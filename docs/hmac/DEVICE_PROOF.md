# Device proof of possession (phase 2)

[DEVICE_KEYS](DEVICE_KEYS.md) gives each device its own HMAC key, but the key is still a secret string the device holds, so someone with access to the device (or its storage) can copy it. With proof of possession the device creates a **non-extractable key pair** with WebCrypto. The private key never leaves the device; the backend only vouches for the public key, and the Worker checks an ECDSA signature on every request.

## How it fits together

1. **Device:** generates an ECDSA P-256 key pair (`extractable: false`) and sends the public key to your backend after login.
2. **Backend:** binds the public key to the device ID with an enrollment token and returns it. The token is `HMAC-SHA256(masterSecret, "enroll:" + deviceId + "|" + publicKey)` as lowercase hex. The backend holds the master secret; the device never does.
3. **Device, per request:** signs the usual message with the private key and sends the public key and enrollment token along.
4. **Worker:** recomputes the enrollment token (so the key really was enrolled for this device ID), then verifies the ECDSA signature. It stores nothing.

`publicKey` is the raw 65-byte uncompressed point, base64url without padding (what `exportKey('raw', ...)` returns).

## Config

```json
{ "deviceKeys": { "mode": "optional", "proof": "allowed", "revoked": [] } }
```

| `proof` | Behaviour |
|---|---|
| (absent) | Off: `X-Device-Pub` and `X-Enroll-Token` are ignored. |
| `allowed` | A request with `X-Device-Pub` is checked as proof; every other request is checked as before (shared or derived HMAC key). Use it during the rollout. |
| `required` | Every signed request must carry proof. Shared and derived HMAC keys stop working. |

`revoked` and `strictReplay` apply to proof requests too. Revoking a device ID stops it at once even if its enrollment token is still valid.

## Request headers

Same as the HMAC scheme ([HMAC_TOKEN_GUIDE](HMAC_TOKEN_GUIDE.md)), with these differences:

| Header | Value |
|---|---|
| `X-Device-Id` | required |
| `X-Device-Pub` | the public key, base64url |
| `X-Enroll-Token` | the backend's token for that device ID and key |
| `X-Auth-Token` | the ECDSA signature as **128 lowercase hex characters** (`r` then `s`, 64 bytes, which is what WebCrypto's `sign` returns) |

The signed message is unchanged: `timestamp|METHOD|path+query|bodyHash|User-Agent|nonce|deviceId`.

## Client example (browser)

```js
// once, after login: create the key pair and enroll it
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
// extractable:false makes the PRIVATE key non-extractable, but the public key can still be exported:
const pub = b64u(await crypto.subtle.exportKey('raw', pair.publicKey));
const { enrollToken } = await api.post('/enroll', { deviceId, pub });   // your backend
// store pair (CryptoKey objects can be kept in IndexedDB) and enrollToken

// every request
const message = `${ts}|${method}|${pathAndQuery}|${bodyHash}|${navigator.userAgent}|${nonce}|${deviceId}`;
const sig = hex(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(message)));
```

## Backend example (Node.js)

```js
import { createHmac } from 'node:crypto';
const enrollToken = createHmac('sha256', process.env.AUTH_SALT).update(`enroll:${deviceId}|${pub}`).digest('hex');
```

Only issue it for a user you have authenticated, and choose the `deviceId` yourself (for example a UUID per login). Validate that `pub` decodes to 65 bytes starting with `0x04`.

## Rollout

1. Backend: add the enrollment endpoint. Client: create the key pair after login and send proof headers.
2. Set `"proof": "allowed"`. Old clients keep working.
3. When every client sends proof, set `"proof": "required"`.

## Notes and limits

- With `X-Key-Id` rotation, the enrollment token is computed with the key that `X-Key-Id` selects, so rotating the master secret invalidates enrollments made with the old key once it is retired. Devices re-enroll.
- **Before `required`, rotate the master secret.** The enrollment token is keyed with the master secret, so anyone who still holds a copy (every legacy client does) could mint an enrollment for a key of their own and pass as proof. `required` only closes that gap once old copies are dead: retire the old key id in `AUTH_KEYS` first, and keep the secret on the backend only.
- Replay protection for proof requests is keyed on the signed device id and nonce, not on the signature, because an ECDSA signature can be rewritten into a different valid one for the same message.
- An enrollment token has no expiry. To end a device's access, add its ID to `revoked`, or rotate the master secret.
- Non-extractable keys stop copying the key out of the browser; they do not stop malicious code running on the device from asking the browser to sign. Treat it as protection against stolen secrets, not against a compromised device.
- Tested with a WebCrypto key pair only; try it with your real client before turning on `required`.
- Per-device rate limiting is not included: the in-Worker limiter is per IP.
