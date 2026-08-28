// Server-side provisioning for the phone's voice stream — the app-owned
// slice of what `pnpm cli voicelab talk` does: call the voice-agent guest
// entrypoint's setupVoiceAgent for OUR stream, but only when a local marker
// says the config this app would send has never been asserted (grill Q4:
// setup pays an occurrence-keyed append plus a warm barrier, dead latency on
// every tap if repeated; a content-hash marker is the cheap idempotence).
//
// No posture-flip guard, deliberately: each line owns its path and only
// ever sends one posture. The template DOES auto-install now (absent only
// — see ensureVoiceAgentInstalled): a project that has never seen voice
// gets the embedded guest worker committed during the ring, instead of an
// eternal ring ending in a "needs setup" caption.

import { VOICE_AGENT_TEMPLATE_FILES } from "./voice-template.generated.ts";

/** Where a phone's calls live: stable per device (grill Q3) — the boards'
 * pattern — so the per-stream colleague and the reconnect recap give the
 * phone ONE ongoing voice relationship instead of an amnesiac per call. */
export function mobileVoiceStreamPath(deviceId: string): string {
  return `/agents/voice/mobile-${deviceId}`;
}

/**
 * Where a CHAT's calls live: one line per chat, shared by every device —
 * the chat's phone number, not the phone's. `/agents/mobile/173…` →
 * `/agents/voice/chat/mobile/173…`; the certificate's `colleaguePath` (the
 * chat itself) is what makes the chat agent the backend, so the derived
 * voice-notes path never comes into play.
 */
export function chatVoiceStreamPath(chatPath: string): string {
  const suffix = chatPath.startsWith("/agents/")
    ? chatPath.slice("/agents/".length)
    : chatPath.replace(/^\//, "");
  return `/agents/voice/chat/${suffix}`;
}

/** Mirrors apps/os/scripts/voicelab/voice-agent-ref.ts — the guest
 * entrypoint committed by `voicelab deploy`/`talk`, never worker.ts. */
export const voiceAgentEntrypointRef = {
  path: "/",
  source: {
    createWorker: {
      entryPoint: "voice-agent.ts",
      files: { repoPath: "/repos/config", type: "repo" },
    },
  },
  type: "stateless",
};

/**
 * The birth certificate this app asserts. Push-to-talk (clientTakesTurns:
 * the phone segments turns with the hold-to-talk button — the first
 * on-device session showed open-mic needs AEC tuning this demo hasn't
 * earned yet), colleague on, and the same hang_up tool talk.ts arms — the
 * model saying goodbye is one of the three ways a call ends (tap, hang_up,
 * 60s idle).
 */
export const MOBILE_VOICE_SETUP = {
  instructions: "You are Iterate, a voice assistant on a phone. Keep replies short and natural.",
  clientTakesTurns: true,
  colleague: true,
  /** The phone rings, so the other end picks up (facet 17.0.0): the model
   * greets first — "hi again" on a stream with history, via the recap. */
  greeting: true,
  tools: [
    {
      name: "hang_up",
      description:
        "End this call when the user says goodbye or the conversation is " +
        "clearly over. Say a short goodbye BEFORE calling this; the call " +
        "ends after you finish speaking.",
    },
  ],
};

/**
 * The certificate for one call target. The per-device line takes the base
 * config; a per-chat line adds `colleaguePath` (facet 18.0.0), which is
 * what flips the arrangement to "this chat's agent is the backend".
 */
export function voiceSetupConfig(colleaguePath: string | null): Record<string, unknown> {
  return colleaguePath === null
    ? { ...MOBILE_VOICE_SETUP }
    : { ...MOBILE_VOICE_SETUP, colleaguePath };
}

/** Bump to force one re-setup on every device after changing the setup
 * semantics in a way the config hash alone would not capture (marker v4:
 * facet 18.0.0 — call-start colleague link + transcript lane). */
const SETUP_MARKER_VERSION = 4;

/** FNV-1a over the exact payload we would send — pure, no crypto import, and
 * two devices/app-versions agree iff they would send identical setups. */
export function setupMarker(streamPath: string, config: Record<string, unknown>): string {
  const material = JSON.stringify({
    config,
    streamPath,
    version: SETUP_MARKER_VERSION,
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** The slice of the project handle this module dials. */
export interface VoiceSetupWorkers {
  get(ref: unknown): {
    setupVoiceAgent(options: Record<string, unknown>): Promise<unknown>;
  };
}

/** The slice of the config-repo handle the auto-install dials — the same
 * two calls apps/os/scripts/voicelab/deploy.ts makes. */
export interface VoiceSetupRepo {
  readFile(input: { path: string }): Promise<{ content?: string } | string | null>;
  commitFiles(input: {
    changes: { content: string; path: string }[];
    message: string;
  }): Promise<unknown>;
}

/**
 * Put the embedded voice-agent template into the project's config repo when
 * it has none — the fresh/recycled-project case that used to be an eternal
 * ring ending in "the project may need voice set up" (Misha, on-device,
 * 2026-08-28). ABSENT ONLY: a present voice-agent.ts is left alone whatever
 * its version — `voicelab deploy` owns upgrades, and an app must never
 * downgrade a project's template to the one it happened to ship with.
 */
export async function ensureVoiceAgentInstalled(repo: VoiceSetupRepo): Promise<void> {
  const existing = await repo.readFile({ path: "voice-agent.ts" }).catch(() => null);
  const content = typeof existing === "string" ? existing : existing?.content;
  if (typeof content === "string" && content !== "") return;
  await repo.commitFiles({
    changes: VOICE_AGENT_TEMPLATE_FILES,
    message: "mobile: auto-install the voice-agent template (first call)",
  });
}

/**
 * Assert the stream's certificate unless the stored marker says this exact
 * config already was. A failed setup NEVER writes the marker — the next tap
 * retries — and the caller must not open the mic on failure.
 */
export async function ensureVoiceAgentSetup(deps: {
  workers: VoiceSetupWorkers;
  repo: VoiceSetupRepo;
  streamPath: string;
  /** The chat this line calls (per-chat mode), or null for the device's own line. */
  colleaguePath: string | null;
  readMarker: (streamPath: string) => Promise<string | null>;
  writeMarker: (streamPath: string, marker: string) => Promise<void>;
}): Promise<void> {
  const config = voiceSetupConfig(deps.colleaguePath);
  const marker = setupMarker(deps.streamPath, config);
  if ((await deps.readMarker(deps.streamPath)) === marker) return;
  /* Inside the marker miss on purpose: one repo read per config change,
   * not per call — and the ring covers the install when it does happen. */
  await ensureVoiceAgentInstalled(deps.repo);
  await deps.workers
    .get(voiceAgentEntrypointRef)
    .setupVoiceAgent({ streamPath: deps.streamPath, ...config });
  await deps.writeMarker(deps.streamPath, marker);
}
