// Server-side provisioning for the phone's voice stream — the app-owned
// slice of what `pnpm cli voicelab talk` does: call the voice-agent guest
// entrypoint's setupVoiceAgent for OUR stream, but only when a local marker
// says the config this app would send has never been asserted (grill Q4:
// setup pays an occurrence-keyed append plus a warm barrier, dead latency on
// every tap if repeated; a content-hash marker is the cheap idempotence).
//
// No template install and no posture-flip guard, deliberately: the guest
// worker is installed project-wide by the voicelab tooling, and this device
// owns its UUID'd path and only ever sends one posture.

/** Where a phone's calls live: stable per device (grill Q3) — the boards'
 * pattern — so the per-stream colleague and the reconnect recap give the
 * phone ONE ongoing voice relationship instead of an amnesiac per call. */
export function mobileVoiceStreamPath(deviceId: string): string {
  return `/agents/voice/mobile-${deviceId}`;
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
} as const;

/**
 * The birth certificate this app asserts. Push-to-talk (clientTakesTurns:
 * the phone segments turns with the hold-to-talk button — the first
 * on-device session showed open-mic needs AEC tuning this demo lane hasn't
 * earned yet), colleague on, and the same hang_up tool talk.ts arms — the
 * model saying goodbye is one of the three ways a call ends (tap, hang_up,
 * 60s idle).
 */
export const MOBILE_VOICE_SETUP = {
  instructions: "You are Iterate, a voice assistant on a phone. Keep replies short and natural.",
  clientTakesTurns: true,
  colleague: true,
  tools: [
    {
      name: "hang_up",
      description:
        "End this call when the user says goodbye or the conversation is " +
        "clearly over. Say a short goodbye BEFORE calling this; the call " +
        "ends after you finish speaking.",
    },
  ],
} as const;

/** Bump to force one re-setup on every device after changing MOBILE_VOICE_SETUP
 * semantics that the hash alone would not capture. */
const SETUP_MARKER_VERSION = 2;

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
  streamPath: string;
  readMarker: (streamPath: string) => Promise<string | null>;
  writeMarker: (streamPath: string, marker: string) => Promise<void>;
}): Promise<void> {
  const marker = setupMarker(deps.streamPath);
  if ((await deps.readMarker(deps.streamPath)) === marker) return;
  await deps.workers
    .get(voiceAgentEntrypointRef)
    .setupVoiceAgent({ streamPath: deps.streamPath, ...MOBILE_VOICE_SETUP });
  await deps.writeMarker(deps.streamPath, marker);
}
