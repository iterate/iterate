import { createFileRoute } from "@tanstack/react-router";
import { itxEnv, workerVersion } from "../env.ts";

const workerVersionHeader = "x-iterate-worker-version";

/**
 * Trivial liveness probe. Preview readiness compares the version header with
 * wrangler's uploaded version; it deliberately does not wake synthetic
 * Durable Objects because a finite placement sample cannot prove the fleet.
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
