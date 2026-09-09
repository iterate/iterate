/**
 * The guest's RPC surface, as plain types.
 *
 * What a caller that never runs the agent needs: the voicelab CLI, the mobile
 * app, a project's own worker.ts. Kept apart from voice-agent.ts so that
 * importing these pulls in neither Cloudflare's runtime types nor the
 * processor contract — a phone has neither. The agent's entrypoint class
 * `implements` VoiceAgentRpc, so the two cannot drift.
 */

/** A realtime voice provider this agent can dial. */
export type VoiceProvider = "grok" | "openai";

/**
 * One step of an itx expression — the platform's persisted-capability shape
 * (apps/os/src/itx/expression.ts): a string is a property read,
 * [method, ...args] is a call. The agent's contract validates the same
 * shape with a reserved-name guard.
 */
export type ItxExpressionStepInput = string | [method: string, ...args: unknown[]];

/**
 * One tool the model may call, as data on the birth certificate.
 *
 * `expression` is a walk from the PROJECT ROOT to a function; the model's
 * parsed arguments object is that function's single argument. Persisting an
 * expression persists the NAME of a capability, never its authority — every
 * call re-derives authority from a fresh project session. A tool with NO
 * expression is a name the agent already knows how to be: `hang_up` is the
 * only one.
 */
export interface VoiceToolInput {
  name: string;
  /** What the provider shows the model; usage guidance lives here, not in
   * `instructions` — "say goodbye BEFORE calling this" rides the tool. */
  description: string;
  /** JSON Schema for the arguments, handed to the provider verbatim.
   * Absent means a no-argument tool. */
  parameters?: Record<string, unknown>;
  expression?: ItxExpressionStepInput[];
}

export interface SetupVoiceAgentOptions {
  /** The conversation stream. A fresh /agents/voice/* path is generated when omitted. */
  streamPath?: string;
  /**
   * Dial THIS instead of x.ai, for a deterministic test.
   *
   * NO CREDENTIAL FOLLOWS IT — see `secretForHost` in voice-agent.ts: a host
   * that is no known provider's gets no Authorization header and no setup
   * gate.
   */
  providerBaseUrl?: string;
  /** Which realtime voice provider the birth certificate names. Default grok. */
  provider?: VoiceProvider;
  /** Model and voice overrides for that provider. */
  providerModel?: string;
  providerVoice?: string;
  /** What to tell the model it is. Empty leaves the provider's own default. */
  instructions?: string;
  /**
   * This client segments its own turns with the push-to-talk verbs.
   *
   * Omitted means Grok listens, which is what every board wants. Say true only
   * for a client that really does own its turns — a terminal holding the space
   * bar — because on an open microphone it means Grok is never told a turn
   * ended, and the call goes silent with nothing logged.
   */
  clientTakesTurns?: boolean;
  /** The provider's own turn_detection object, verbatim, for open-mic VAD
   * tuning per stream. Omitted takes the measured defaults. */
  turnDetection?: Record<string, unknown> & { type: string };
  /** Classify the answer into mouth shapes for a face-rendering client. */
  visemes?: boolean;
  /** Speak first when a call connects (contract 17.0.0). */
  greeting?: boolean;
  /** `note_to_self` writes to the stream's one colleague agent (per stream,
   * not per conversation — contract 12.0.0) and its chat replies are read
   * back into whichever call is live. ON unless explicitly false — every
   * stream is born with its colleague (contract 10.0.0). */
  colleague?: boolean;
  /** Make an EXISTING agent (a chat) the colleague instead of the derived
   * `/agents/voice-notes/...` desk — contract 18.0.0's "call any chat"
   * mode. The call's transcript lands on that agent's stream and its every
   * chat message is spoken into the live call. */
  colleaguePath?: string;
  /** Tools the model may call: name/description/parameters go to the
   * provider; the itx expression is the run. No expression = hang_up. */
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
/** A line for the live call's voice to say now; the idle reaper's farewell
 * uses the same path. An idle stream just keeps the record. */
export interface SayOptions {
  /** The conversation stream the line is for. */
  streamPath: string;
  /** What to say, as close to word-for-word as natural speech allows. */
  text: string;
  /** Why — recorded on the event and, with `thenHangUp`, on the obituary. */
  reason?: string;
  /** Who asked; defaults to "entrypoint.say". */
  by?: string;
  /** Close the call once the line has PLAYED (never before). */
  thenHangUp?: boolean;
  /** Address one call; absent, whichever call is live. */
  conversationId?: string;
}

/** What `say` appended: the stream and the event's offset. */
export interface SayResult {
  streamPath: string;
  offset: number;
}

export interface VoiceAgentRpc {
  health: () => Promise<VoiceAgentHealth>;
  setupVoiceAgent: (options?: SetupVoiceAgentOptions) => Promise<SetupVoiceAgentResult>;
  removeVoiceAgent: (options: { streamPath: string }) => Promise<{ streamPath: string }>;
  say: (options: SayOptions) => Promise<SayResult>;
}
