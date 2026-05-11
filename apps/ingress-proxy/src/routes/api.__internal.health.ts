import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/__internal/health")({
  server: {
    handlers: {
      GET: async () => Response.json({ ok: true, app: "ingress-proxy" }),
    },
  },
});
