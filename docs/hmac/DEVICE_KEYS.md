# Per-device signing keys (phase 1)

Today every client signs with the same secret, so one leaked copy exposes everyone and any holder can claim any `X-Device-Id`. With device keys each device signs with its **own key**, derived from the master secret, so one leaked device key exposes only that device and a device can be revoked on its own.

```
deviceKey = HMAC-SHA256(masterSecret, "device:" + deviceId)     // lowercase hex string
```

The Worker derives the same key on every request, so nothing is stored. The device key is used exactly like the old secret (as a UTF-8 string) to sign the usual message, which includes `|deviceId` at the end ([HMAC_TOKEN_GUIDE](HMAC_TOKEN_GUIDE.md)). `masterSecret` is the key the request would otherwise use: `AUTH_SALT`, or the `AUTH_KEYS` entry picked by `X-Key-Id`.

## Config

```json
{ "deviceKeys": { "mode": "optional", "revoked": ["device-aaaa1111"] } }
```

| Mode | Behaviour |
|---|---|
| (absent) | Off. Everything works as before. |
| `optional` | A request with `X-Device-Id` may be signed with the device key **or** the master key. Requests without an ID use the master key. Use this while clients are updated. |
| `required` | An `X-Device-Id` is mandatory and only the device key is accepted. The master key no longer works on HMAC routes. |

`revoked` lists device IDs refused in either mode (403). It takes effect when the config reloads (within `CACHE_TTL`, or at once after a cache flush). Device IDs are 8 to 64 characters of letters, digits, `.`, `_` or `-`.

## Enrollment: keep the master secret off the device

The master secret must never reach a device. After the user logs in, your **backend** derives the device key and returns it:

```js
// Node.js, on your backend
import { createHmac } from 'node:crypto';
const deviceKey = createHmac('sha256', process.env.AUTH_SALT).update(`device:${deviceId}`).digest('hex');
// send { deviceId, deviceKey } to the client over your authenticated session
```

The client stores the key and signs with it. Choose `deviceId` on the backend (for example a random UUID per login) rather than letting the client pick it.

## Rollout

1. Backend: add the enrollment endpoint above. Clients: fetch a device key after login and sign with it.
2. Set `"mode": "optional"` and deploy. Old clients keep working.
3. When old clients are gone, set `"mode": "required"`.
4. To cut off a lost or abusive device, add its ID to `revoked`.

## What this does not do

- A device key can still be copied out of the browser by someone with access to that device. [DEVICE_PROOF](DEVICE_PROOF.md) (a non-extractable key pair per device) addresses that.
- Replay checking is still per Worker instance.
- Per-device rate limiting is not included: the in-Worker limiter is per IP.
