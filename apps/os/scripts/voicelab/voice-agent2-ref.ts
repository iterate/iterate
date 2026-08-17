import type { StatelessDynamicWorkerRef } from "iterate/sdk";

/**
 * The second track's guest entrypoint, committed by `voicelab deploy2`.
 *
 * A SEPARATE FILE FROM `voice-agent-ref.ts` because both tracks live in the
 * same flat config repo at the same time — that is the whole point of the
 * exercise, running them side by side against the same boards and the same
 * provider — and a ref that named one entry point for both would silently make
 * whichever was deployed last answer for both.
 */
export const voiceAgent2EntrypointRef = {
  path: "/",
  source: {
    createWorker: {
      entryPoint: "voice-agent2.ts",
      files: { repoPath: "/repos/config", type: "repo" },
    },
  },
  type: "stateless",
} satisfies StatelessDynamicWorkerRef;
