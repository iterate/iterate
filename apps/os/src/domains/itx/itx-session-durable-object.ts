import { DurableObject } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { parseConfig } from "../../config.ts";
import type { Env } from "../../env.ts";
import { createItxRpcSessionOptions } from "../../itx/itx-observability.ts";
import { runHttpWideLog } from "../../observability/operation.ts";
import { wideLogger } from "../../observability/wide-log.ts";
import { UnauthenticatedOsRpcTarget } from "../../rpc-targets.ts";
import { registerItxSessionTransport } from "../../session-transport.ts";

/**
 * One Cap'n Web connection. In a stateless Worker, all socket messages share
 * the original fetch's CPU allowance; a Durable Object receives a fresh CPU
 * budget on every incoming message. The ingress Worker only forwards the
 * upgrade, so it never processes the session's frames.
 * https://developers.cloudflare.com/durable-objects/platform/limits/
 *
 * The RPC export table and live capability mounts are connection-local memory.
 * Use ordinary WebSocket acceptance: hibernation would discard that state.
 * No storage or alarms are needed; reconnecting creates a new session object.
 */
export class ItxSessionDurableObject extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const config = parseConfig(this.env);
    // Ingress captures a rejected upgrade once, at the external boundary.
    return runHttpWideLog(() => {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("This endpoint only accepts WebSocket requests.", { status: 400 });
      }
      // Ingress generates this name independently for every upgrade.
      const sessionId = this.ctx.id.name!;
      wideLogger.set({ itx: { sessionId } });
      const pair = new WebSocketPair();
      const server = pair[0];
      server.accept();
      // A lost capability provider must still close the client transport,
      // allowing the client to reconnect and restore its mounts.
      registerItxSessionTransport(this.ctx, (code, reason) => server.close(code, reason));
      newWebSocketRpcSession(
        // Cloudflare's socket implements Cap'n Web's transport interface;
        // its event overloads differ from the DOM WebSocket declaration.
        server as unknown as Parameters<typeof newWebSocketRpcSession>[0],
        new UnauthenticatedOsRpcTarget({
          config,
          ctx: this.ctx,
          headers: request.headers,
          requestUrl: request.url,
        }),
        createItxRpcSessionOptions({
          transport: "websocket",
          sessionId,
          parentLogId: wideLogger.id(),
        }),
      );
      return new Response(null, { status: 101, webSocket: pair[1] });
    });
  }
}
