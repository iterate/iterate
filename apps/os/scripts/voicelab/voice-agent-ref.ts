import type { StatelessDynamicWorkerRef } from "iterate/sdk";

/** The guest entrypoint committed by `voicelab deploy`; never the project's worker.ts. */
export const voiceAgentEntrypointRef = {
  path: "/",
  source: {
    createWorker: {
      entryPoint: "voice-agent.ts",
      files: { repoPath: "/repos/config", type: "repo" },
    },
  },
  type: "stateless",
} satisfies StatelessDynamicWorkerRef;
