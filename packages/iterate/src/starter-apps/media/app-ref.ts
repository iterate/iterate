// The MediaApp's physical identity: a stable durable key preserves its
// processor storage across implementation updates.
import type { StatefulDynamicWorkerRef } from "../../sdk.ts";

export const mediaStreamPath = "/media";

export const mediaWorkerRef = {
  className: "MediaApp",
  durableWorkerKey: "app-media-stream",
  path: "/",
  source: {
    createWorker: {
      entryPoint: "node_modules/iterate/dist/starter-apps/media/configured-worker.mjs",
      files: {
        include: ["package.json"],
        repoPath: "/repos/config",
        type: "repo",
      },
    },
  },
  type: "stateful",
} satisfies StatefulDynamicWorkerRef;
