import { createFileRoute } from "@tanstack/react-router";
import { WebSocketResponse } from "../../lib/ws-response";
import { wsRpcHandler } from "../../orpc/ws-handler";

export const Route = createFileRoute("/api/rpc-ws")({
  server: {
    handlers: {
      GET: () =>
        new WebSocketResponse({
          message(peer, message) {
            return wsRpcHandler.message(peer, message, { context: {} });
          },
          close(peer) {
            wsRpcHandler.close(peer);
          },
          error(peer) {
            wsRpcHandler.close(peer);
          },
        }),
    },
  },
});
