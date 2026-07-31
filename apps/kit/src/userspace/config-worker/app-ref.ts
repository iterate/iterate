import type { StatefulDynamicWorkerRef } from "iterate/sdk";

/**
 * The durable key and itx path are the application's identity, not a source
 * cache key. They therefore remain stable while installed source evolves.
 */
export const kitVoiceWorkerRef = {
  className: "KitVoiceWorker",
  durableWorkerKey: "app-kit-voice-v1",
  path: "/kit/",
  source: {
    createWorker: {
      entryPoint: "apps/kit-voice/worker.ts",
      files: {
        include: ["package.json", "apps/kit-voice/**"],
        repoPath: "/repos/config",
        type: "repo",
      },
    },
  },
  type: "stateful",
} satisfies StatefulDynamicWorkerRef;
