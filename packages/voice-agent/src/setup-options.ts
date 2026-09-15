/**
 * The guest's RPC surface, as plain types.
 *
 * What a caller that never runs the agent needs: the voicelab CLI, the mobile
 * app, a project's own worker.ts. Kept apart from voice-agent.ts so that
 * importing these pulls in neither Cloudflare's runtime types nor the
 * processor contract — a phone has neither. The agent's entrypoint class
 * `implements` VoiceAgentRpc, so the two cannot drift.
 */

export interface SetupVoiceAgentOptions {
  /** The conversation stream. A fresh /agents/voice/* path is generated when omitted. */
  streamPath?: string;
  /**
   * Start a fresh provider session while this stream's voice facet catches up.
   *
   * A device generates this opaque activation once per local conversation and
   * opens its downlink subscription in parallel. It waits for the resulting
   * `conversation-accepted` event before flushing its locally buffered PCM.
   * Omit it when installing a voice facet without opening a conversation.
   */
  activation?: string;
  /** What GPT-Live is told it is — persona and tone. */
  instructions?: string;
  /** Classify the answer into mouth shapes for a face-rendering client. */
  visemes?: boolean;
  /** Install the subscription under a fresh key even if an identical one exists. */
  reinstall?: boolean;
}

/** What setup did, in enough detail for a caller to print it. */
export interface SetupVoiceAgentResult {
  streamPath: string;
  /** Setup's own clock: batch appended to fold-through proven. Cold build included. */
  warmMs: number;
}

/** What `health` proves: the guest is built, running, and can reach its project. */
export interface VoiceAgentHealth {
  ok: true;
  projectId: string;
  buildCacheKey: string;
}

/**
 * The stateless entrypoint's methods, as a caller dials them through
 * `itx.workers.get(voiceAgentEntrypointRef)`. Property signatures rather than
 * method signatures: the declaration bundler's printer cannot emit the latter
 * inside an interface, and a class method satisfies either.
 */
export interface VoiceAgentRpc {
  health: () => Promise<VoiceAgentHealth>;
  setupVoiceAgent: (options?: SetupVoiceAgentOptions) => Promise<SetupVoiceAgentResult>;
  removeVoiceAgent: (options: { streamPath: string }) => Promise<{ streamPath: string }>;
}
