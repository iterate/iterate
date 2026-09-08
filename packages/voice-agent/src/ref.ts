/**
 * Where the built guest sits once the config repo's package.json declares
 * this package. The dynamic worker host installs that package.json's
 * dependencies and builds from here; the repo itself contributes nothing
 * else, which is what `files.include` says.
 */
export const VOICE_AGENT_WORKER_ENTRYPOINT =
  "node_modules/@iterate-com/voice-agent/dist/configured-worker.mjs";

/**
 * The platform's repo-sourced dynamic worker shape, spelled here rather than
 * imported: the SDK's ref types come with Cloudflare's runtime types, which a
 * phone or a browser holding these refs does not have. ref.test.ts holds the
 * refs against the SDK's own types, so the two cannot drift.
 */
export interface VoiceAgentWorkerSource {
  createWorker: {
    entryPoint: string;
    files: { include: string[]; repoPath: string; type: "repo" };
  };
}

export interface VoiceAgentEntrypointRef {
  path: string;
  source: VoiceAgentWorkerSource;
  type: "stateless";
}

export interface VoiceAgentFacetRef {
  className: string;
  durableWorkerKey: string;
  path: string;
  source: VoiceAgentWorkerSource;
  type: "stateful";
}

const source: VoiceAgentWorkerSource = {
  createWorker: {
    entryPoint: VOICE_AGENT_WORKER_ENTRYPOINT,
    files: { include: ["package.json"], repoPath: "/repos/config", type: "repo" },
  },
};

/** The stateless entrypoint: `health`, `setupVoiceAgent`, `removeVoiceAgent`. Never the project's worker.ts. */
export const voiceAgentEntrypointRef: VoiceAgentEntrypointRef = {
  path: "/",
  source,
  type: "stateless",
};

/**
 * The STATEFUL facet worker for one conversation stream — the mirror of the
 * ref voice-agent.ts builds for itself, spelled here so a CLI can address
 * (and kill) it.
 *
 * The durable key predates this package: keeping it means a project that
 * moves from a committed copy of the agent to the package keeps its facet
 * state. Why a CLI ever needs to kill it: a stateful durable worker keeps the
 * bundle it booted with for as long as it stays warm, and back-to-back
 * voicelab runs keep it warm indefinitely — measured on prd (2026-08-26
 * evening): the facet served a build three commits stale while the STATELESS
 * entrypoint rebuilt fresh on every run, so setup wrote the new contract's
 * filter and the running facet honored the old one. After any install that
 * changed the repo, kill it; the next dispatch boots the build just declared.
 */
export function voiceAgentFacetRef(streamPath: string): VoiceAgentFacetRef {
  return {
    className: "VoiceAgentFacet",
    durableWorkerKey: "voice-agent-facet",
    path: streamPath,
    source,
    type: "stateful",
  };
}
