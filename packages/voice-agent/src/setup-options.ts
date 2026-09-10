/**
 * The guest's RPC surface, as plain types.
 *
 * What a caller that never runs the agent needs: the voicelab CLI, the mobile
 * app, a project's own worker.ts. Kept apart from voice-agent.ts so that
 * importing these pulls in neither Cloudflare's runtime types nor the
 * processor contract — a phone has neither. The agent's entrypoint class
 * `implements` VoiceAgentRpc, so the two cannot drift.
 */

/**
 * One step of an itx expression — the platform's persisted-capability shape
 * (apps/os/src/itx/expression.ts): a string is a property read,
 * [method, ...args] is a call. The agent's contract validates the same
 * shape with a reserved-name guard.
 */
export type ItxExpressionStepInput = string | [method: string, ...args: unknown[]];

/**
 * One tool the backend model may call, as data on the birth certificate.
 *
 * `expression` is a walk from the PROJECT ROOT to a function; the model's
 * parsed arguments object is that function's single argument. Persisting an
 * expression persists the NAME of a capability, never its authority — every
 * call re-derives authority from a fresh project session. A tool with NO
 * expression is a name the agent already knows how to be: `hang_up` is the
 * only one.
 *
 * The voice model itself has no tools — GPT-Live delegates — so every tool
 * here reaches the BACKEND model, which calls it in a second or two.
 */
export interface VoiceToolInput {
  name: string;
  /** What the model is shown; usage guidance lives here, not in
   * `instructions` — "say goodbye BEFORE calling this" rides the tool. */
  description: string;
  /** JSON Schema for the arguments, handed to the provider verbatim.
   * Absent means a no-argument tool. */
  parameters?: Record<string, unknown>;
  expression?: ItxExpressionStepInput[];
}

/**
 * The backend the voice delegates to (GPT-Live's Responses delegation): a
 * hosted model armed with `exec_typescript` against this project plus the
 * certificate's tools. Every field is an override of the package's defaults
 * — `gpt-6-astra`, reasoning effort `low`, the `priority` (Fast) tier.
 */
export interface VoiceBackendInput {
  /** The Responses model, e.g. `gpt-6-astra`, `gpt-5.6-terra`. */
  model?: string;
  /** `reasoning.effort` for that model. */
  reasoningEffort?: string;
  /** `service_tier`; `priority` is OpenAI's Fast mode. */
  serviceTier?: string;
  /** Extra backend instructions, appended to the package's own brief. */
  instructions?: string;
}

export interface SetupVoiceAgentOptions {
  /** The conversation stream. A fresh /agents/voice/* path is generated when omitted. */
  streamPath?: string;
  /**
   * Dial THIS instead of api.openai.com, for a deterministic test.
   *
   * NO CREDENTIAL FOLLOWS IT — see `secretForHost` in voice-agent.ts: a host
   * that is not OpenAI's gets no Authorization header and no setup gate.
   */
  providerBaseUrl?: string;
  /** Model and voice overrides; `gpt-live-1` and `marin` by default. */
  providerModel?: string;
  providerVoice?: string;
  /** What the voice is told it is — persona and tone. The delegation
   * policy is appended by the agent; keep this short. */
  instructions?: string;
  /** Classify the answer into mouth shapes for a face-rendering client. */
  visemes?: boolean;
  /** Speak first when a call connects (contract 17.0.0). */
  greeting?: boolean;
  /** Backend overrides — see {@link VoiceBackendInput}. */
  backend?: VoiceBackendInput;
  /** Tools the backend may call — see {@link VoiceToolInput}. */
  tools?: VoiceToolInput[];
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
