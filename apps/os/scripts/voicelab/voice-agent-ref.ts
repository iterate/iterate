import type { StatefulDynamicWorkerRef, StatelessDynamicWorkerRef } from "iterate/sdk";

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

/**
 * The STATEFUL facet worker — the mirror of `voiceAgentFacetRef` inside
 * voice-agent.ts, spelled here so the CLI can address (and kill) it.
 *
 * Why the CLI ever needs to: a stateful durable worker keeps the bundle it
 * booted with for as long as it stays warm, and back-to-back voicelab runs
 * keep it warm indefinitely — measured on prd (2026-08-26 evening): the
 * facet served a build three commits stale while the STATELESS entrypoint
 * rebuilt fresh on every run, so setup wrote the new contract's filter and
 * the running facet honored the old one. `talk` kills it after any install
 * that changed content; the next dispatch boots the build just committed.
 */
export function voiceAgentFacetRef(streamPath: string) {
  return {
    className: "VoiceAgentFacet",
    durableWorkerKey: "voice-agent-facet",
    path: streamPath,
    source: {
      createWorker: {
        entryPoint: "voice-agent.ts",
        files: { repoPath: "/repos/config", type: "repo" },
      },
    },
    type: "stateful",
  } satisfies StatefulDynamicWorkerRef;
}
