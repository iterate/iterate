/**
 * WebSocket "gateways" for the pet shop — the transport shapes the OS
 * secret-worker model must support beyond header-bearing HTTP, where a
 * credential rides on a WebSocket rather than a plain-HTTP Authorization header
 * (apps/os/docs/integrations-and-secrets-design.md §R2, §9 D6). All three
 * gateways validate the SAME sealed access token petshop's OAuth issues; they
 * differ only in HOW that token is presented, which is exactly the axis the OS
 * side proves:
 *
 *   - `/gateway`              the Discord shape — token inside the IDENTIFY
 *                             FRAME. Auth happens after the socket opens, so a
 *                             secret worker holds the token and sends it itself.
 *   - `/gateway-header`       the OpenAI-Realtime shape — token in the
 *                             `Authorization: Bearer` header AT THE UPGRADE.
 *   - `/gateway-subprotocol`  the browser-WS shape — token smuggled in
 *                             `Sec-WebSocket-Protocol` at the upgrade (browsers
 *                             cannot set arbitrary headers, so the subprotocol
 *                             list is the only auth channel).
 *
 * The header/subprotocol tokens substitute into UPGRADE HEADERS on the OS side
 * (getSecret(...) placeholders resolved at the jailed outbound); the frame token
 * is bytes the worker legitimately holds. This module keeps all protocol logic
 * as pure functions of (state/token, deps) -> frames + close, so the whole thing
 * unit-tests without a live socket; worker.ts wires them to real WebSocketPairs.
 *
 * Protocol (JSON text frames, Discord-shaped op names):
 *   server->client on connect:  {"op":"hello","heartbeatIntervalMs":30000}
 *   auth (per shape above) valid   -> {"op":"ready","user":{sub,clientId}} then
 *                                     one demo {"op":"dispatch","type":"pet.created",...}
 *        auth invalid              -> {"op":"invalid","reason":"..."} + close(4001)
 *   client->server after ready:    echoed as {"op":"echo","received":<frame>}
 *
 * Heartbeats are advertised (hello's interval) but not enforced — this is a
 * test fixture, not a real gateway; we never drop a client for a missing beat.
 */
import { nowSeconds, unseal } from "./seal.ts";

/** Close code Discord uses for a failed IDENTIFY; we reuse it for any auth failure. */
export const AUTH_FAILED_CLOSE_CODE = 4001;

/** The heartbeat cadence advertised in the hello frame (never enforced here). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The real subprotocol the `/gateway-subprotocol` server selects and echoes back
 * in its 101 response. Never the token entry — reflecting the credential in the
 * response would leak it back to any observer of the handshake.
 */
export const GATEWAY_SUBPROTOCOL = "petshop.v1";

/**
 * The prefix marking the offered subprotocol that carries the access token
 * (`petshop.access-token.<sealed token>`). This is the browser-WS auth idiom:
 * the token is one of the comma-separated values in `Sec-WebSocket-Protocol`.
 */
export const SUBPROTOCOL_TOKEN_PREFIX = "petshop.access-token.";

/**
 * Sealed access-token payload, validated exactly like worker.ts `accessGrant`
 * (redeclared here to keep the gateway module self-contained). The token — in an
 * IDENTIFY frame, an Authorization header, or a subprotocol value — is always
 * the *same* sealed access token the OAuth flow issues.
 */
interface AccessPayload {
  t: "access";
  sub: string;
  clientId: string;
  epoch: number;
  exp: number;
}

/** The minimal state a connection carries between frames: whether IDENTIFY has happened. */
export interface GatewayConnectionState {
  identified: boolean;
}

/** A fresh, un-identified connection — what the route handler starts each socket with. */
export function newGatewayConnection(): GatewayConnectionState {
  return { identified: false };
}

/** The hello frame the server sends the instant a socket opens (before any client frame). */
export function helloFrame(): string {
  return JSON.stringify({ op: "hello", heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS });
}

/**
 * What the gateway must do with the state it needs to validate a token: the
 * sealing key (to unseal it) and the current revocation epoch for the token's
 * client. Structurally a subset of PetshopDeps so the route handler passes its
 * own deps straight through.
 */
export interface GatewayDeps {
  sealKey: string;
  /** Reads the client's CURRENT epoch at auth time—not a value snapshotted at
   * upgrade—so targeted expiry between upgrade and auth is still enforced. */
  getAccessTokenEpoch: (clientId: string) => Promise<number>;
}

/**
 * The result of handling one authentication attempt or client frame: the JSON
 * text frames to send back (in order), and, when authentication fails, the close
 * directive to apply after sending them.
 */
export interface GatewayReaction {
  send: string[];
  close?: { code: number; reason: string };
}

/** The reaction to any auth failure: an `invalid` frame then close(4001). Shared
 * by all three shapes so a bad token looks identical however it was presented. */
function authFailure(reason: string): GatewayReaction {
  return {
    send: [JSON.stringify({ op: "invalid", reason })],
    close: { code: AUTH_FAILED_CLOSE_CODE, reason: "authentication failed" },
  };
}

/** The frames a freshly-authenticated connection emits: `ready` plus one demo
 * `dispatch` (the inbound event a Discord-style gateway would push on connect),
 * so a client observes a dispatch immediately. Shared by all three shapes. */
function readyReaction(grant: AccessPayload): GatewayReaction {
  return {
    send: [
      JSON.stringify({ op: "ready", user: { sub: grant.sub, clientId: grant.clientId } }),
      JSON.stringify({
        op: "dispatch",
        type: "pet.created",
        data: { id: "pet-3", name: "Rex", species: "terrier" },
      }),
    ],
  };
}

/**
 * Validate a bearer access token exactly like worker.ts `accessGrant`, wherever
 * it arrived from: unseal, `t === "access"`, not expired, and minted under the
 * current epoch. The one validation every gateway shape shares.
 */
async function accessGrantFromToken(
  token: unknown,
  deps: GatewayDeps,
): Promise<AccessPayload | null> {
  if (typeof token !== "string" || !token.length) return null;
  const grant = await unseal<AccessPayload>(token, deps.sealKey);
  if (!grant || grant.t !== "access" || grant.exp < nowSeconds()) return null;
  if (grant.epoch !== (await deps.getAccessTokenEpoch(grant.clientId))) return null;
  return grant;
}

/**
 * The `/gateway` (Discord frame) protocol as a pure-ish function (its only
 * impurity is `unseal`, deterministic given the key). Given the connection
 * state, a raw client text frame, and the deps to validate a token, it returns
 * the frames to send and whether to close — and mutates `state.identified` once
 * a valid IDENTIFY lands. The route handler applies the reaction to a real
 * socket; tests call it directly. Also serves as the post-auth ECHO loop for the
 * header/subprotocol shapes, which start with `state.identified === true`.
 */
export async function handleGatewayMessage(
  state: GatewayConnectionState,
  raw: string,
  deps: GatewayDeps,
): Promise<GatewayReaction> {
  // After IDENTIFY (frame shape) or a valid upgrade (header/subprotocol shapes),
  // every further frame is echoed back verbatim.
  if (state.identified) {
    return { send: [JSON.stringify({ op: "echo", received: raw })] };
  }

  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return authFailure("first frame must be JSON identify");
  }
  if (!frame || typeof frame !== "object" || frame.op !== "identify") {
    return authFailure("first frame must be an identify frame");
  }

  const grant = await accessGrantFromToken(frame.token, deps);
  if (!grant) {
    return authFailure("missing, invalid, or expired token");
  }

  state.identified = true;
  return readyReaction(grant);
}

/**
 * The upgrade-time auth shared by `/gateway-header` and `/gateway-subprotocol`:
 * the token is validated ONCE at the handshake (not in a later frame), so a
 * valid token opens an already-`identified` connection. Returns the frames to
 * send after the hello (ready + dispatch on success, invalid + close(4001) on
 * failure) and whether the connection is now identified — the route handler
 * seeds its GatewayConnectionState with that so subsequent frames echo.
 */
export async function handleUpgradeAuth(
  token: unknown,
  deps: GatewayDeps,
): Promise<GatewayReaction & { identified: boolean }> {
  const grant = await accessGrantFromToken(token, deps);
  if (!grant) return { ...authFailure("missing, invalid, or expired token"), identified: false };
  return { ...readyReaction(grant), identified: true };
}

/** Extract a bearer token from an `Authorization` header value (the
 * OpenAI-Realtime upgrade shape), or null if absent/malformed. */
export function bearerTokenFromHeader(authorization: string | null): string | null {
  if (!authorization || !/^bearer /i.test(authorization)) return null;
  return authorization.slice(7).trim() || null;
}

/**
 * Parse a `Sec-WebSocket-Protocol` header (the browser-WS shape): pull the
 * access token out of the `petshop.access-token.<token>` carrier, and pick the
 * subprotocol the server should echo back — a real, non-token value (preferring
 * {@link GATEWAY_SUBPROTOCOL}). The selected value is NEVER the token carrier, so
 * the credential is not reflected in the 101 response. Sealed tokens are
 * base64url (no commas), so comma-splitting the offered list is safe.
 */
export function subprotocolAuth(header: string | null): {
  token: string | null;
  selected: string | null;
} {
  const offered = (header ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => !!value.length);
  const carrier = offered.find((value) => value.startsWith(SUBPROTOCOL_TOKEN_PREFIX));
  const token = carrier ? carrier.slice(SUBPROTOCOL_TOKEN_PREFIX.length) : null;
  const selected = offered.includes(GATEWAY_SUBPROTOCOL)
    ? GATEWAY_SUBPROTOCOL
    : (offered.find((value) => !value.startsWith(SUBPROTOCOL_TOKEN_PREFIX)) ?? null);
  return { token, selected };
}
