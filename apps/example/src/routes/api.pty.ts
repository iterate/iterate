import { createFileRoute } from "@tanstack/react-router";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";

// This file is just to show how you can create arbitrary websocket handlers in your app
// Under the hood NitroWebSocketResponse attaches .crossws to the response object,
// which nitro then picks up
export const Route = createFileRoute("/api/pty")({
  server: {
    handlers: {
      GET: ({ context, request }) => new NitroWebSocketResponse(context.pty(request)),
    },
  },
});
