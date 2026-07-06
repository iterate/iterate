/**
 * A Discord-style WebSocket "gateway" (GET /gateway, Upgrade: websocket) for
 * the pet shop. This exercises the one transport shape the OS secret-worker
 * model must support beyond header-bearing HTTP: a credential that rides
 * *inside a WebSocket frame* rather than an Authorization header
 * (integrations-and-secrets-design.md §R2, §3 "Discord" — a secret worker
 * holds a socket to Discord and injects its bot token in an IDENTIFY frame).
 *
 * The gateway is per-connection and stateless — no Durable Object. Its whole
 * protocol lives in `handleGatewayMessage`, a pure function of
 * (connection state, raw client frame) → the frames to send + whether to
 * close. The route handler in worker.ts wires that to a real WebSocketPair;
 * unit tests drive the exact same function without a live socket.
 *
 * Protocol (JSON text frames, Discord-shaped op names):
 *   server→client on connect:  {"op":"hello","heartbeatIntervalMs":30000}
 *   client→server first frame:  {"op":"identify","token":"<sealed access token>"}
 *     valid   → {"op":"ready","user":{sub,clientId}} then one demo
 *               {"op":"dispatch","type":"pet.created","data":{...}}
 *     invalid → {"op":"invalid","reason":"..."} + close(4001)
 *   client→server after ready:  echoed as {"op":"echo","received":<frame>}
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
 * Sealed access-token payload, validated exactly like worker.ts `accessGrant`
 * (redeclared here to keep the gateway module self-contained). The token in an
 * IDENTIFY frame is the *same* sealed access token the OAuth flow issues.
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
 * What the gateway must do with the state it needs to validate an IDENTIFY:
 * the sealing key (to unseal the token) and the current access-token epoch (to
 * reject epoch-revoked tokens). Structurally a subset of PetshopDeps so the
 * route handler passes its own deps straight through.
 */
export interface GatewayDeps {
  sealKey: string;
  /** Reads the CURRENT access-token epoch at IDENTIFY time — not a value
   * snapshotted at upgrade — so a token revoked by expire-tokens between
   * upgrade and IDENTIFY is rejected, exactly like the HTTP routes. */
  getAccessTokenEpoch: () => Promise<number>;
}

/**
 * The result of handling one client frame: the JSON text frames to send back
 * (in order), and, when authentication fails, the close directive to apply
 * after sending them.
 */
export interface GatewayReaction {
  send: string[];
  close?: { code: number; reason: string };
}

/**
 * Validate a bearer access token exactly like worker.ts `accessGrant`, only
 * the token arrives from a frame instead of an Authorization header: unseal,
 * `t === "access"`, not expired, and minted under the current epoch.
 */
async function accessGrantFromToken(
  token: unknown,
  deps: GatewayDeps,
): Promise<AccessPayload | null> {
  if (typeof token !== "string" || token.length === 0) return null;
  const grant = await unseal<AccessPayload>(token, deps.sealKey);
  if (!grant || grant.t !== "access" || grant.exp < nowSeconds()) return null;
  if (grant.epoch !== (await deps.getAccessTokenEpoch())) return null;
  return grant;
}

/**
 * The whole gateway protocol as a pure-ish function (its only impurity is
 * `unseal`, which is deterministic given the key). Given the connection state,
 * a raw client text frame, and the deps needed to validate a token, it returns
 * the frames to send and whether to close — and mutates `state.identified`
 * once a valid IDENTIFY lands. The route handler applies the reaction to a
 * real socket; tests call it directly.
 */
export async function handleGatewayMessage(
  state: GatewayConnectionState,
  raw: string,
  deps: GatewayDeps,
): Promise<GatewayReaction> {
  const authFailure = (reason: string): GatewayReaction => ({
    send: [JSON.stringify({ op: "invalid", reason })],
    close: { code: AUTH_FAILED_CLOSE_CODE, reason: "authentication failed" },
  });

  // After IDENTIFY, every further frame is echoed back verbatim.
  if (state.identified) {
    return { send: [JSON.stringify({ op: "echo", received: raw })] };
  }

  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return authFailure("first frame must be JSON identify");
  }
  if (frame === null || typeof frame !== "object" || frame.op !== "identify") {
    return authFailure("first frame must be an identify frame");
  }

  const grant = await accessGrantFromToken(frame.token, deps);
  if (!grant) {
    return authFailure("missing, invalid, or expired token");
  }

  state.identified = true;
  return {
    send: [
      JSON.stringify({ op: "ready", user: { sub: grant.sub, clientId: grant.clientId } }),
      // One demo inbound event so a freshly-connected client immediately
      // observes a dispatch — the payload a Discord gateway would push.
      JSON.stringify({
        op: "dispatch",
        type: "pet.created",
        data: { id: "pet-3", name: "Rex", species: "terrier" },
      }),
    ],
  };
}
