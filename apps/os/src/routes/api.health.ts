import { createFileRoute } from "@tanstack/react-router";
import { itxEnv, workerVersion } from "../env.ts";

const workerVersionHeader = "x-iterate-worker-version";

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
