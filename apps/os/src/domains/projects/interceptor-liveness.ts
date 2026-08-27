// The interceptor liveness lane: the mount invariant, extended to the Project
// Durable Object's live interceptor slots (itx.ai.intercept, itx.egress.intercept).
//
// Those slots are memory-only — a retained handler stub that reaches back to
// the installing session — so the slot dies whenever the DO incarnation does
// (deploy propagation, eviction, revival), and before this lane existed that
// loss was SILENT: the client's session socket stayed open while every
// intercepted call failed. Live capability mounts never had that hole; their
// invariant (session-transport.ts) is "an open session socket means a live
// mount, and mount loss always arrives as a close event (4901)".
//
// This lane gives interceptors the same carrier. Installing an interceptor
// dials the Project DO a PLAIN (non-hibernatable) WebSocket, claimed by the
// install call, so its lifetime IS the incarnation's lifetime: while it is
// open the runtime keeps the incarnation (and the slot) resident, and the
// incarnation's death closes it. The session side then tears the client
// transport down with 4901 so the client's one reconnect loop re-installs.
// Deliberate teardown — release, or supersession by a newer intercept() —
// closes with a recognized reason and stays silent: a superseded session's
// reconnect loop must not fight the newer interceptor.

import { z } from "zod";
import { closeItxSessionTransport } from "../../session-transport.ts";

export const INTERCEPTOR_LIVENESS_HEADER = "x-iterate-interceptor-liveness";

export const InterceptorLivenessUpgrade = z.object({ interceptId: z.string().min(1) });

/** Deliberate DO-side closes; anything else arriving at the session is loss. */
export const INTERCEPTOR_SUPERSEDED_CLOSE_REASON = "superseded by a newer interceptor";
export const INTERCEPTOR_RELEASED_CLOSE_REASON = "interceptor released";

const DELIBERATE_CLOSE_REASONS: readonly string[] = [
  INTERCEPTOR_SUPERSEDED_CLOSE_REASON,
  INTERCEPTOR_RELEASED_CLOSE_REASON,
];

/** Dial the Project DO's liveness lane; the install call claims the socket by id. */
export async function dialInterceptorLiveness(input: {
  interceptId: string;
  stub: { fetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}): Promise<WebSocket> {
  const upgrade = await input.stub.fetch("https://interceptor-liveness.internal/", {
    headers: {
      Upgrade: "websocket",
      [INTERCEPTOR_LIVENESS_HEADER]: JSON.stringify({ interceptId: input.interceptId }),
    },
  });
  const socket = upgrade.webSocket;
  if (socket === null) {
    throw new Error(`interceptor liveness upgrade returned ${upgrade.status} without a WebSocket`);
  }
  socket.accept();
  return socket;
}

/**
 * Session-side half of the invariant: watch the claimed liveness socket, and
 * when it closes WITHOUT a deliberate reason — the Durable Object incarnation
 * died with the slot — close this session's client transport (4901) so the
 * client reconnects and installs again. `markDeliberate()` before any teardown
 * this side initiates; sessions with no client transport (HTTP batch,
 * Durable-Object-side itx) have no registration and the close is a no-op,
 * exactly like the capability pager's onPagerLost.
 *
 * The close reason MUST stay ≤123 UTF-8 bytes: a longer reason makes
 * WebSocket.close() THROW, and an unsent close is a silently broken invariant.
 */
export function watchInterceptorLiveness(input: {
  ctx: object;
  slot: "AI" | "egress";
  socket: WebSocket;
}): { markDeliberate(): void } {
  let deliberate = false;
  const onLost = (reason: string) => {
    if (deliberate) return;
    deliberate = true;
    if (DELIBERATE_CLOSE_REASONS.includes(reason)) return;
    closeItxSessionTransport(
      input.ctx,
      4901,
      `project ${input.slot} interceptor lost (Durable Object restarted); reconnect and intercept() again`,
    );
  };
  input.socket.addEventListener("close", (event) => onLost(event.reason));
  input.socket.addEventListener("error", () => onLost("websocket error"));
  return {
    markDeliberate: () => {
      deliberate = true;
    },
  };
}
