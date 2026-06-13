import { createFileRoute } from "@tanstack/react-router";

/**
 * Trivial liveness probe. Replaces the oRPC `__internal.health` procedure: a
 * plain JSON route the runtime smoke test and external tooling can hit without
 * any RPC client.
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => Response.json({ ok: true, app: "os" }),
    },
  },
});
