/**
 * The guest's RPC surface, as plain types.
 *
 * What a caller that never runs the agent needs: the voicelab CLI, the mobile
 * app, a project's own worker.ts. Kept apart from voice-agent.ts so that
 * importing these pulls in neither Cloudflare's runtime types nor the
 * processor contract — a phone has neither. The agent's entrypoint class
 * `implements` VoiceAgentRpc, so the two cannot drift.
 */

/** Configuration for the standard OS Agent that handles work during a call. */
export interface VoiceBackendInput {
  /** Standard Agent model identifier; defaults to openai/gpt-6-astra. */
  model?: string;
}

export interface SetupVoiceAgentOptions {
  /** The conversation stream. A fresh /agents/voice/* path is generated when omitted. */
  streamPath?: string;
  /** What GPT-Live is told it is — persona and tone. */
  instructions?: string;
  /** Classify the answer into mouth shapes for a face-rendering client. */
  visemes?: boolean;
  /** Explicit standard-Agent model override; otherwise the Agent's normal configuration applies. */
  backend?: VoiceBackendInput;
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
