/**
 * The file in a project's config repo that the platform builds as the voice
 * guest worker. It is three lines, written by the installer:
 *
 *   export { default, VoiceAgentFacet } from "@iterate-com/voice-agent/worker";
 *
 * The platform bundles it the way it bundles worker.ts — resolving the
 * package from the repo's package.json — so the repo holds a name, not a copy.
 */
export const VOICE_AGENT_GUEST_FILE = "voice-agent.ts";

/**
 * The platform's repo-sourced dynamic worker shape, spelled here rather than
 * imported: the SDK's ref types come with Cloudflare's runtime types, which a
 * phone or a browser holding these refs does not have. ref.test.ts holds the
 * refs against the SDK's own types, so the two cannot drift.
 */
export interface VoiceAgentWorkerSource {
  createWorker: {
    entryPoint: string;
    files: { repoPath: string; type: "repo" };
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
    entryPoint: VOICE_AGENT_GUEST_FILE,
    files: { repoPath: "/repos/config", type: "repo" },
  },
};

/** The stateless entrypoint: `health`, `setupVoiceAgent`, `removeVoiceAgent`. Never the project's worker.ts. */
export const voiceAgentEntrypointRef: VoiceAgentEntrypointRef = {
  path: "/",
  source,
  type: "stateless",
};

/**
 * The STATEFUL facet worker for one conversation stream — the ref the agent's
 * own setup writes into the stream's subscription, spelled once here so a CLI
 * can address (and kill) the same thing.
 *
 * The durable key predates this package: a project that moves from a
 * committed copy of the agent to the package keeps its facet state. Why a CLI
 * ever needs to kill it: a stateful durable worker keeps the bundle it booted
 * with for as long as it stays warm, and back-to-back voicelab runs keep it
 * warm indefinitely — measured on prd (2026-08-26 evening): the facet served
 * a build three commits stale while the STATELESS entrypoint rebuilt fresh on
 * every run. After any install that changed the repo, kill it; the next
 * dispatch boots the build the repo declares now.
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
