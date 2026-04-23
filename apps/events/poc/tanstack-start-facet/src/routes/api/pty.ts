import { createFileRoute } from "@tanstack/react-router";
import { WebSocketResponse } from "../../lib/ws-response";

export const Route = createFileRoute("/api/pty")({
  server: {
    handlers: {
      GET: ({ context }) => new WebSocketResponse(context.pty()),
    },
  },
});
