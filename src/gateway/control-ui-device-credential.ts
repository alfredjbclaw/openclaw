// Device-bound Control UI HTTP credential.
//
// A Control UI browser reaching the Gateway through managed Tailscale Serve
// authenticates its websocket with verified tailnet identity plus a device
// keypair proof, but that lane deliberately skips pairing, so `ensureDeviceToken`
// has no paired row to bind and the browser ends up holding no credential for its
// later HTTP reads. This fills exactly that gap: the connect handshake mints one
// after the device proof is verified, and the consolidated Control UI read
// authorizer accepts it where a paired-device token would otherwise be required.
//
// It is deliberately not an ambient-identity grant. A request that never
// completed the authenticated websocket connect cannot produce one, the
// credential carries only the read scope the assistant-media surfaces need, and
// callers pin it to the managed-Serve ingress it was issued on so an exfiltrated
// copy is useless off the tailnet.
import { randomBytes } from "node:crypto";
import { createControlUiSignedToken, readControlUiSignedToken } from "./control-ui-signed-token.js";
import { READ_SCOPE } from "./operator-scopes.js";

const CONTROL_UI_DEVICE_CREDENTIAL_SCOPE = "control-ui-device-http";
const CONTROL_UI_DEVICE_CREDENTIAL_TTL_MS = 12 * 60 * 60 * 1000;
// Process-lifetime secret: a Gateway restart invalidates every outstanding
// credential, and the browser reconnects to mint a replacement.
const controlUiDeviceCredentialSecret = randomBytes(32);

/** Mint the post-connect HTTP credential bound to a device that proved its keypair. */
export function issueControlUiDeviceCredential(params: {
  deviceId: string;
  authGeneration: string | undefined;
  nowMs?: number;
}): { credential: string; expiresAtMs: number } | null {
  const deviceId = params.deviceId.trim();
  if (!deviceId) {
    return null;
  }
  const signed = createControlUiSignedToken({
    secret: controlUiDeviceCredentialSecret,
    scope: CONTROL_UI_DEVICE_CREDENTIAL_SCOPE,
    claims: { deviceId, authGeneration: params.authGeneration ?? null },
    ttlMs: CONTROL_UI_DEVICE_CREDENTIAL_TTL_MS,
    ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
  });
  return signed ? { credential: signed.token, expiresAtMs: signed.expiresAtMs } : null;
}

/** Operator scopes a presented credential authorizes, or null when it is not one. */
export function verifyControlUiDeviceCredential(params: {
  credential: string | null | undefined;
  authGeneration: string | undefined;
  nowMs?: number;
}): string[] | null {
  const claims = readControlUiSignedToken({
    secret: controlUiDeviceCredentialSecret,
    scope: CONTROL_UI_DEVICE_CREDENTIAL_SCOPE,
    token: params.credential,
    ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
  });
  // An intact device binding is what separates this from ambient identity, and
  // rotating the shared gateway secret retires the credentials it was issued under.
  if (!claims || typeof claims.deviceId !== "string" || !claims.deviceId) {
    return null;
  }
  return claims.authGeneration === (params.authGeneration ?? null) ? [READ_SCOPE] : null;
}
