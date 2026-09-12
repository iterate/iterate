// Server-side provisioning for the phone's voice stream — the app-owned
// slice of what `pnpm cli voicelab talk` does: call the voice-agent guest
// entrypoint's setupVoiceAgent for OUR stream, but only when a local marker
// says the config this app would send has never been asserted (grill Q4:
// setup pays an occurrence-keyed append plus a warm barrier, dead latency on
// every tap if repeated; a content-hash marker is the cheap idempotence).
//
// No posture-flip guard, deliberately: each line owns its path and only
// ever sends one posture. The agent DOES auto-install now (absent only —
// see ensureVoiceAgentInstalled): a project that has never seen voice gets
// @iterate-com/voice-agent declared in its config repo during the ring,
// instead of an eternal ring ending in a "needs setup" caption.

import {
  installVoiceAgent,
  type VoiceAgentConfigRepo,
  voiceAgentEntrypointRef,
} from "@iterate-com/voice-agent";

export { voiceAgentEntrypointRef };

/**
 * Where a CHAT's calls live: one line per chat, shared by every device —
 * the chat's phone number, not the phone's. `/agents/mobile/173…` →
 * `/agents/voice/chat/mobile/173…`. The backend is the facet's own
 * delegation target (gpt-6-astra with the project's itx); the chat is
 * where the call's UI lives, not a party on the wire.
 */
export function chatVoiceStreamPath(chatPath: string): string {
  const suffix = chatPath.startsWith("/agents/")
    ? chatPath.slice("/agents/".length)
    : chatPath.replace(/^\//, "");
  return `/agents/voice/chat/${suffix}`;
}

/**
 * The birth certificate this app asserts. GPT-Live listens continuously; the
 * standard Agent can request a hang-up after its goodbye. Physical mute,
 * explicit hang-up, and idle closure remain local call controls.
 */
export const MOBILE_VOICE_SETUP = {
  instructions:
    "You are Iterate, on a phone call with someone who knows you well. Casual, " +
    "direct, brief — never customer-service polish. Greet in a couple of words ('hey', " +
    "'hi again'), answer in plain short sentences, acknowledge in two or three words.",
};

/** The certificate for one call target: the same on every line — what
 * differs per chat is the stream path, which the marker also hashes. */
export function voiceSetupConfig(): Record<string, unknown> {
  return { ...MOBILE_VOICE_SETUP };
}

/** Bump to force one re-setup on every device after changing the setup
 * semantics in a way the config hash alone would not capture. v9 removes
 * the frontend greeting request: GPT-Live starts by listening. */
const SETUP_MARKER_VERSION = 9;

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

/** The slice of the config-repo handle the auto-install dials. */
export type VoiceSetupRepo = VoiceAgentConfigRepo;

/**
 * Declare @iterate-com/voice-agent in the project's config repo when it is
 * not there — the fresh/recycled-project case that used to be an eternal
 * ring ending in "the project may need voice set up" (Misha, on-device,
 * 2026-08-28). ABSENT ONLY: a declaration that is already there is left
 * alone whatever it pins — `voicelab deploy` owns upgrades, and an app must
 * never move a project off a version somebody chose. Which build then runs
 * is the platform's: it pins every such spec to the ref it deployed with,
 * so the app no longer ships (or chooses) a copy of the agent.
 */
export async function ensureVoiceAgentInstalled(repo: VoiceSetupRepo): Promise<void> {
  await installVoiceAgent(repo, {
    existing: "keep",
    message: "mobile: depend on @iterate-com/voice-agent (first call)",
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
  readMarker: (streamPath: string) => Promise<string | null>;
  writeMarker: (streamPath: string, marker: string) => Promise<void>;
}): Promise<void> {
  const config = voiceSetupConfig();
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
