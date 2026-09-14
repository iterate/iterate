// Provision the phone's voice stream once per setup payload. A local marker
// avoids an install and setup barrier on every call.

import {
  installVoiceAgent,
  type VoiceAgentConfigRepo,
  voiceAgentEntrypointRef,
} from "@iterate-com/voice-agent";

export { voiceAgentEntrypointRef };

/**
 * Where a CHAT's calls live: one line per chat, shared by every device —
 * the chat's phone number, not the phone's. `/agents/mobile/173…` →
 * `/agents/voice/chat/mobile/173…`. The chat supplies the stream path and
 * call UI; it is not a party on the voice wire.
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

/** Bump to force one re-setup on every device after changing the setup
 * semantics in a way the config hash alone would not capture. v9 removes
 * the frontend greeting request: GPT-Live starts by listening. */
const SETUP_MARKER_VERSION = 9;

/** FNV-1a over the exact payload we would send — pure, no crypto import, and
 * two devices/app-versions agree iff they would send identical setups. */
export function setupMarker(streamPath: string): string {
  const material = JSON.stringify({
    config: MOBILE_VOICE_SETUP,
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

/**
 * Assert the stream's certificate unless the stored marker says this exact
 * config already was. A failed setup NEVER writes the marker — the next tap
 * retries — and the caller must not open the mic on failure.
 */
export async function ensureVoiceAgentSetup(deps: {
  workers: VoiceSetupWorkers;
  repo: VoiceAgentConfigRepo;
  streamPath: string;
  readMarker: (streamPath: string) => Promise<string | null>;
  writeMarker: (streamPath: string, marker: string) => Promise<void>;
}): Promise<void> {
  const marker = setupMarker(deps.streamPath);
  if ((await deps.readMarker(deps.streamPath)) === marker) return;
  await installVoiceAgent(deps.repo, {
    existing: "keep",
    message: "mobile: depend on @iterate-com/voice-agent (first call)",
  });
  await deps.workers
    .get(voiceAgentEntrypointRef)
    .setupVoiceAgent({ streamPath: deps.streamPath, ...MOBILE_VOICE_SETUP });
  await deps.writeMarker(deps.streamPath, marker);
}
