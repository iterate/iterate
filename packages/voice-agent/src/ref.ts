/**
 * The file in a project's config repo that the platform builds as the voice
 * guest worker. It is three lines, written by the installer:
 *
 *   export { default, VoiceAgentFacet } from "@iterate-com/voice-agent/worker";
 *
 * The platform bundles it the way it bundles worker.ts — resolving the
 * package from the repo's package.json — so the repo holds a name, not a copy.
 */
import { voiceAgentRefConfig } from "./ref-config.ts";

export const VOICE_AGENT_GUEST_FILE = voiceAgentRefConfig.guestFile;

/**
 * The platform's repo-sourced dynamic worker shape, spelled here rather than
 * imported: the SDK's ref types come with Cloudflare's runtime types, which a
 * phone or a browser holding these refs does not have. ref.test.ts holds the
 * refs against the SDK's own types, so the two cannot drift.
 */
export interface VoiceAgentWorkerSource {
  createWorker: {
    entryPoint: string;
    files: {
      repoPath: string;
      type: "repo";
      /** An installed source release, frozen before a call begins. */
      ref?: { commitOid: string };
    };
  };
}

export interface VoiceAgentEntrypointRef {
  path: string;
  props?: { voiceAgentSourceCommitOid: string };
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

interface VoiceAgentRefOptions {
  guestFile?: string;
  durableWorkerKey?: string;
  sourceCommitOid?: string;
}

/** Source text for a source install's small, generated worker-name module. */
export function voiceAgentRefConfigSource(
  options: Required<Pick<VoiceAgentRefOptions, "guestFile" | "durableWorkerKey">>,
): string {
  return `/** Build-local worker names. Source installs replace this file as a unit. */\nexport const voiceAgentRefConfig = ${JSON.stringify(options, null, 2)} as const;\n`;
}

/** Matching entrypoint and facet refs for one installed worker source. */
export function voiceAgentRefs(options: VoiceAgentRefOptions = {}) {
  const guestFile = options.guestFile || voiceAgentRefConfig.guestFile;
  const durableWorkerKey = options.durableWorkerKey || voiceAgentRefConfig.durableWorkerKey;
  const sourceCommitOid = options.sourceCommitOid;
  const source: VoiceAgentWorkerSource = {
    createWorker: {
      entryPoint: guestFile,
      files: {
        repoPath: "/repos/config",
        type: "repo",
        ...(sourceCommitOid && { ref: { commitOid: sourceCommitOid } }),
      },
    },
  };
  const entrypoint: VoiceAgentEntrypointRef = {
    path: "/",
    ...(sourceCommitOid && { props: { voiceAgentSourceCommitOid: sourceCommitOid } }),
    source,
    type: "stateless",
  };
  return {
    entrypoint,
    facet(streamPath: string): VoiceAgentFacetRef {
      return {
        className: "VoiceAgentFacet",
        durableWorkerKey,
        path: streamPath,
        source,
        type: "stateful",
      };
    },
  };
}

/** The stateless entrypoint: `health`, `setupVoiceAgent`, `removeVoiceAgent`. Never the project's worker.ts. */
export const voiceAgentEntrypointRef = voiceAgentRefs().entrypoint;

/** Default branch-head facet ref for callers without an installed source release. */
export function voiceAgentFacetRef(streamPath: string): VoiceAgentFacetRef {
  return voiceAgentRefs().facet(streamPath);
}
