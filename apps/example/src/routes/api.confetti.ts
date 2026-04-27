import { createFileRoute } from "@tanstack/react-router";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import { createConfettiWebSocketHooks } from "~/lib/confetti-websocket.ts";

export const Route = createFileRoute("/api/confetti")({
  server: {
    handlers: {
      GET: () => new NitroWebSocketResponse(createConfettiWebSocketHooks()),
    },
  },
});
