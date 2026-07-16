import { createFileRoute } from "@tanstack/react-router";
import { itxEnv, workerVersion } from "../env.ts";

const workerVersionHeader = "x-iterate-worker-version";

/**
 * Trivial liveness probe. Replaces the oRPC `__internal.health` procedure: a
 * plain JSON route the runtime smoke test and external tooling can hit without
 * any RPC client.
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => {
        const version = workerVersion(itxEnv);
        return Response.json(
          { ok: true, app: "os", version },
          {
            headers: {
              "cache-control": "no-store",
              [workerVersionHeader]: version,
            },
          },
        );
      },
    },
  },
});
