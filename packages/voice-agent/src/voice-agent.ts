/**
 * The voice agent, third cut: GPT-Live on the wire, one fold, one reaction,
 * and a sequence number on every frame that says which direction it travels.
 *
 * WHAT CHANGED, AND WHY IT IS A CUT RATHER THAN AN EDIT.
 *
 * The second cut ran a TURN-BASED provider (gpt-realtime, grok) and spent most
 * of its lines on what that implies: a VAD onset that may or may not be an
 * echo blip, a response lifecycle to cancel, an item to truncate so the
 * model's memory matched what the room heard, a `note_to_self` tool and a
 * response.create choreography so the voice could ask its own backend for
 * help and find a moment to speak the answer. GPT-Live is FULL DUPLEX and
 * handles every one of those hand-offs natively — measured from this Mac before a
 * line of this was written (apps/os/scripts/voicelab/live-probe.ts):
 *
 *   - Output audio is a CONTINUOUS stream at exactly realtime, one 100 ms
 *     delta per 100 ms, silence included — and idle silence is digital
 *     zero. So there is no burst to pace, no "the provider is ahead of the
 *     room", and an answer is simply a run of deltas that are not silent.
 *   - Interrupted mid-count, the voice went quiet 71 ms after the person
 *     began speaking, and recalled the last number it had said. No cancel,
 *     no truncate, no heard-prefix note: the model reasons over its own
 *     outgoing audio and knows what it said.
 *   - The model DELEGATES: `session.delegation.created` arrives ~0.8 s after
 *     the person stops asking, a hosted backend model reasons and calls
 *     functions, and the voice speaks the result. Asked how many files the
 *     config repo holds, gpt-6-astra wrote three itx scripts in a row and
 *     the voice answered 7 s later. That is the front-office/back-office
 *     split this agent built by hand, now a property of the provider.
 *   - Input may simply STOP (a button released, 12 s of nothing) and the
 *     answer still comes.
 *
 * So this cut deletes the realtime dialect AND the hand-built colleague hand-off
 * whole, and keeps what was never about the provider: the device contract,
 * the pacer, the flush watermark, the durable transcript, the idle deadline,
 * eviction recovery.
 *
 * TWO SEQUENCES, AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   `deviceMicFrameSeq`      device microphone -> facet -> provider. Minted by
 *                            the DEVICE; the facet never renumbers it.
 *   `deviceSpeakerFrameSeq`  facet -> device speaker. One per paced chunk.
 *                            A flush names THIS one and no other.
 *
 * EVERY TIMESTAMP SAYS WHERE IT WAS TAKEN, in its name. FOUR CLOCKS, and a
 * fifth that is not a clock of ours:
 *
 *   `...AtDeviceMs`    the client that holds the microphone
 *   `...AtFacetMs`     read inside this processor, `deps.nowAtFacetMs()`
 *   `...AtStreamMs`    the Stream Durable Object's commit stamp
 *   `...AtProviderMs`  a stamp the provider put on its own event
 *   `...TimelineMs`    GPT-Live's SESSION TIMELINE — `start_ms`/`end_ms` on
 *                      transcript fragments, `offset_ms` on a delegation:
 *                      milliseconds of session audio, zero at session.started.
 *                      Comparable only with itself; the transcript grouping
 *                      below is the one consumer.
 *
 * A duration has no `At`: it is `...Ms`, belongs to no clock, and is the ONLY
 * thing safe to send across a boundary.
 *
 * THE CLIENT IS DUMB, AND THAT IS THE DESIGN. Its entire contract is three
 * sentences: send microphone frames up, numbered, forever (or while a button
 * is held — GPT-Live does not care which); play speaker frames in
 * `deviceSpeakerFrameSeq` order; if a frame says
 * `clearSpeakerBufferBeforeFrame`, throw away everything queued before
 * playing it. `lastFrameOfAnswer` still marks the end of each answer, which
 * this cut derives from the stream going silent — the provider has no
 * end-of-answer event, and the clients that wait for one were never taught
 * to infer it from silence.
 *
 * THE SERVER PACES TO THE DEVICE'S BUFFER — still, though GPT-Live rarely
 * exercises it: the wire hands audio over at play rate, so the device's lead
 * is network jitter, not a burst. The pacer stays because a provider that
 * bursts is one release away and the pacer costs nothing when it idles; and
 * because idle SILENCE is dropped here rather than sent, so the downlink
 * carries speech and nothing else.
 *
 * THE SHAPE: REDUCED STATE is what survives an eviction; RUNTIME STATE is the
 * provider socket, the speaker queue, and the open transcript rows. TWO
 * SWITCHES — `reduce` folds, `processEvent` acts — and a third inside the
 * provider socket's message listener, whose comment says why it cannot be a
 * stream event like everything else.
 */
import { IterateWorkerEntrypoint, StreamProcessorFacet, type ProcessorHostDeps } from "iterate/sdk";
import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import {
  defineProcessorContract,
  StreamProcessor,
  type ProcessEventArgs,
  type ReduceArgs,
} from "iterate/processors";
import { z } from "zod";
import { createFace } from "./face.ts";
/* Where the loader finds this facet — the ONE spelling, shared with every
 * caller that addresses it: the package build inside node_modules, never a
 * file in the config repo. The key names the durable worker, so it is
 * load-bearing rather than cosmetic. */
import { voiceAgentFacetRef } from "./ref.ts";
import type {
  SetupVoiceAgentOptions,
  SetupVoiceAgentResult,
  VoiceAgentHealth,
  VoiceAgentRpc,
} from "./setup-options.ts";

/* ========================================================================== */
/* CONSTANTS                                                                  */
/* ========================================================================== */

const OPENAI_SECRET = "/secrets/openai";

/**
 * The provider. One row, not a table: the realtime dialects (grok,
 * gpt-realtime) were deleted with the second cut, and a table of one is a
 * conditional waiting for a second row.
 *
 * `rate` is the PIPELINE's 16 kHz — GPT-Live speaks it natively, so the
 * device's base64 goes to the wire verbatim and the provider's comes back the
 * same way. No resampler anywhere (pcm.ts went with it). The model rides
 * `session.start`, never the URL.
 */
const LIVE = {
  url: "https://api.openai.com/v1/live/sessions",
  model: "gpt-live-1",
  voice: "marin",
  rate: 16_000,
} as const;

/**
 * The backend the voice delegates to, unless the certificate overrides it:
 * the most capable model on the fast tier at low effort. Measured 7 s from
 * delegation to a spoken three-script answer (live-probe, 2026-09-10).
 */
const BACKEND = {
  model: "gpt-6-astra",
  reasoningEffort: "low",
  serviceTier: "priority",
} as const;

/**
 * The most unplayed audio the device may be holding, in wire bytes.
 *
 * DERIVED FROM THE FIRMWARE, NOT CHOSEN. The ring is 320,000 bytes of PCM16 in
 * PSRAM (voice_device_profile.h), and the device skips frames once its backlog
 * passes ITERATE_KIT_VOICE_SPEAKER_HIGH_WATER_MS (9,000 ms) — a ceiling of
 * 288,000 bytes. 128,000 is four seconds, exactly forty frames, and 40% of the
 * ring. The remaining 60% pays for things no instrument on either side can
 * measure: hand-over-to-play lag, a slow playback clock, and a revived
 * incarnation bursting a budget on top of one the dead incarnation already
 * sent. OVERFLOWING IS SILENT — the device refuses whole frames at the door
 * and its loss counters stay innocent — which is why the margin is large.
 *
 * GPT-Live hands audio over at play rate, so this budget is never reached in
 * the ordinary course; it is the safety proof, not the schedule.
 */
export const MAX_DEVICE_SPEAKER_BACKLOG_BYTES = 128_000;

/**
 * The most audio one speaker frame may carry, in bytes.
 *
 * A CEILING, NOT A UNIT. The device appends bytes to a ring and neither end
 * cares where one frame stops. What survives here is the device's receive
 * path: a chunk over ITERATE_KIT_VOICELAB_CHUNK_BYTES (4,800), or a base64
 * encoding over ITERATE_KIT_VOICELAB_B64_CAPACITY (6,912) inside an envelope
 * capped at ITERATE_KIT_VOICELAB_ARGS_CAPACITY (7,600), is dropped at the door
 * without a word. 3,200 is 100 ms — which is also exactly one GPT-Live delta.
 */
export const MAX_SPEAKER_PAYLOAD_BYTES = 3_200;

/**
 * How a provider delta LARGER than the ceiling is cut WITHOUT decoding it:
 * the largest multiple of 3 under the ceiling, sliced off the delta's own
 * base64. Every 4-character base64 group encodes 3 whole bytes, so an
 * interior slice of a group-aligned string is itself valid base64 and the
 * device decodes it with no help; 3,198 is even, so no sample is split.
 */
const IDENTITY_SLICE_BYTES = Math.floor(MAX_SPEAKER_PAYLOAD_BYTES / 3) * 3;
const IDENTITY_SLICE_B64_CHARS = (IDENTITY_SLICE_BYTES / 3) * 4;

/** 16 kHz mono PCM16: two bytes per sample, sixteen samples per millisecond. */
const PCM16_BYTES_PER_MS = 32;

/**
 * A delta whose loudest sample is under this is silence.
 *
 * Measured on the wire (live-probe, 2026-09-10): idle deltas are exact
 * digital zero — 740 of 873 in one 87 s session — with a few dozen
 * near-zero ones at speech edges (peaks under 20, a handful under 100).
 * Speech onsets sit in the thousands. 100 is far above the noise and far
 * below the quietest speech seen; a quiet first syllable clipped by this
 * threshold would be a 100 ms loss, which is why the threshold errs low.
 */
const SPEECH_PEAK = 100;

/**
 * Trailing silence that ends an answer. The provider has no end-of-answer
 * event ("track playback in your client" — the docs), and the clients need
 * `lastFrameOfAnswer`, so the end is inferred: this much silence after
 * speech and the answer is over. Pauses INSIDE an answer are shorter — the
 * count-slowly probe paused ~500 ms between numbers — so a spurious end is
 * possible on a very deliberate speaker; it costs one extra `answer_done`
 * on the device, never audio. The silence up to this bound is SENT, so the
 * device plays the natural tail; silence past it is dropped.
 */
const ANSWER_TAIL_SILENCE_MS = 700;

/**
 * A transcript fragment this far (on the session timeline) after the same
 * speaker's previous one starts a new turn. Fragments carry no turn
 * boundaries — "these events do not define complete turns" — so the durable
 * per-turn transcript is grouped here. Both speakers may overlap
 * (backchannels), which is why the buffers are per speaker.
 */
const TURN_GAP_MS = 1_200;

/** No input from the device for this long and the call is over. Exported
 * for the tests that drive it. */
export const IDLE_TIMEOUT_MS = 60_000;

/**
 * A person whose last transcript fragment is younger than this is still
 * talking. GPT-Live raises a delegation at the first pause, mid-request, and
 * the backend then works from the first clause alone (measured 2026-09-11:
 * "Open a workspace called scratch." created the workspace and asked what
 * file; "Create an agent at" made up a path and asked what it should do).
 * The facet hears the whole request, so a delegation's tool result is HELD
 * while the person is still talking and the rest of what they said goes to
 * the backend with it. Input transcription lags real time by ~250 ms and
 * arrives in fragments; a gap this long is a finished sentence.
 */
const USER_STILL_TALKING_MS = 1_500;
/** The longest a tool result waits for the person to finish. */
const FORWARD_HOLD_MAX_MS = 15_000;
/**
 * Progress notes reach the voice at most this often. The voice turns each
 * note into a filler ("Still checking.") however it is told not to — three
 * in ten seconds on one duplex run — so a fast backend's steps are folded
 * into one note per gap; the latest note is what "how is it going?" needs.
 */
const PROGRESS_NOTE_MIN_GAP_MS = 4_000;

/**
 * The idle stamp advances in steps of this, not per frame. Folding every mic
 * frame's commit stamp made EVERY delivery batch dirty the reduced state; the
 * deadline is sixty seconds, so knowing the device's last input to five is
 * every bit as good, and the fold is a no-op for ~95% of mic batches.
 */
const IDLE_STAMP_STEP_MS = 5_000;

/** How often the idle countdown looks at the facet clock. */
const IDLE_TICK_MS = 5_000;

/**
 * How long after a dial failure before anything may dial again. Without it,
 * a provider outage against an open-mic board is unbounded churn at the
 * board's fifty frames a second.
 */
const DIAL_RETRY_COOLDOWN_MS = 5_000;

/**
 * How long the provider gets from socket adoption to `session.started`.
 * Nothing else bounds this gap, and an open-mic call that never becomes
 * ready is SILENT FOREVER: mic frames keep the idle stamp fresh, so the
 * sixty-second backstop can never fire. Measured handshakes run ~0.5-1 s.
 */
const HANDSHAKE_DEADLINE_MS = 15_000;

/**
 * A backend function that hangs must still be answered: the backend model
 * hears "took too long" and the voice can say so. Sixty seconds because the
 * functions run real itx scripts against the project, and the voice keeps
 * the conversation going meanwhile — that is the whole point of delegation.
 */
const BACKEND_FUNCTION_DEADLINE_MS = 60_000;

/** A function result lives in the backend's context for the rest of the
 * response; nobody budgeted it for a table dump. */
const FUNCTION_OUTPUT_MAX_CHARS = 8_000;

/**
 * How long a decided hang-up waits for the goodbye. The BACKEND calls
 * `hang_up`, and the voice speaks its farewell only after the backend's
 * response completes — so the flag is armed before the goodbye exists, and
 * settling at the next quiet moment would cut the call before "bye" is said.
 * The hang-up settles after the first answer that ENDS after it was armed,
 * or after this grace with no answer at all (a backend that hung up without
 * the voice saying anything). Measured: delegation → first speech runs
 * 0.2–0.9 s on preview; eight seconds is generous to a slow farewell and
 * still ends a silent call while somebody is standing there.
 */
const HANG_UP_GOODBYE_GRACE_MS = 8_000;

/**
 * How much conversation the fold remembers, and so how much a fresh provider
 * session is seeded with. Turns beyond the newest TRANSCRIPT_MAX_TURNS fall
 * off the front; a single turn longer than TRANSCRIPT_TURN_MAX_CHARS is kept
 * head-first. The provider's `input` history takes 128 messages / 8,192
 * tokens; these bounds sit well inside it.
 */
const TRANSCRIPT_MAX_TURNS = 20;
const TRANSCRIPT_TURN_MAX_CHARS = 600;

/** A fold transcript turn: who spoke, and what the provider heard them say. */
interface TranscriptTurn {
  role: "listener" | "assistant";
  text: string;
}

/**
 * Fold one finished turn onto the recap, applying both bounds. The `suffix`
 * (a provenance marker such as "the listener interrupted") lands AFTER the
 * cut, so no long answer can truncate its own caveat away.
 */
function foldTranscriptTurn(
  transcript: TranscriptTurn[],
  turn: TranscriptTurn,
  suffix = "",
): TranscriptTurn[] {
  const text =
    turn.text.length > TRANSCRIPT_TURN_MAX_CHARS
      ? `${turn.text.slice(0, TRANSCRIPT_TURN_MAX_CHARS)}…`
      : turn.text;
  return [...transcript, { role: turn.role, text: `${text}${suffix}` }].slice(
    -TRANSCRIPT_MAX_TURNS,
  );
}

/* ===========================================================================
 * THINKING, FAST AND SLOW — now the provider's own hand-off.
 *
 * The voice model is a mouth, a pair of ears and about 200 ms of judgement;
 * anything that needs reading a repo, calling a tool chain, or being RIGHT
 * belongs to a text model with no clock on it. The second cut built the hand-off
 * by hand: a `note_to_self` tool, a "keep talking" instruction, a colleague
 * agent whose replies were read back at the right moment. GPT-Live has the
 * hand-off built in: the model DELEGATES when it judges a request needs the
 * backend, the provider runs the backend model's loop, and the voice speaks
 * the result when it judges the moment right. What this agent adds is the
 * backend's HANDS: `exec_typescript` against this project (the same contract
 * the OS MCP server hands every client) plus the certificate's tools, run
 * here and answered back into the response. The scripts run on the
 * project's own capability host, so the stream's `backend-reply` events and
 * the host's script-run record are the durable trace of what the backend did.
 * ======================================================================== */

/**
 * What the voice is told about the arrangement, after the certificate's own
 * persona. Structured the way the provider's prompting guide asks — role,
 * backchannel policy, interruption policy, a labelled delegation policy —
 * because the live model has a small context and reads these labels.
 *
 * TRANSPARENT ON PURPOSE, as the second cut learned: a model forbidden to
 * mention its backend rounded every status down to "I'm working on it" and
 * invented explanations for delays. The person may know there is a backend;
 * what they must never get is a made-up story.
 */
const LIVE_DELEGATION_POLICY = [
  "Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing",
  "with the main response.",
  "Interruption policy: Stop speaking when the user interrupts. Listen to what they say.",
  "",
  "Delegation policy:",
  "Backend tools:",
  "- A backend model with code access to this iterate project: it can read and change the",
  "  project, look things up, run scripts, use the line's own tools, and do real work.",
  "Delegate to the backend when:",
  "- The request needs looking up, working out, or doing — anything beyond conversation,",
  "  including anything the line's tools do (ending the call, moving a face, and so on).",
  "- A correction changes work already requested.",
  "Do not delegate to the backend when:",
  "- You can answer from the conversation or a result you already have.",
  "- You need a brief clarification first.",
  "Let the person finish: a pause after a comma or an unfinished sentence is not the end of",
  "the request, and a request delegated half-heard comes back as a clarifying question.",
  "Every request to create, change, run or check something is its own delegation, however",
  "small, and however similar to work already done.",
  "Delegate before giving an answer that depends on backend work. Do not guess the result",
  "while waiting: say you've handed it over and keep the conversation going. Backend progress",
  "notes arrive as thinking: never narrate them step by step; use them only when the person",
  "asks how it is going, or for one short honest update when the work runs long. Say a thing is",
  "done only when the backend has reported it done for THAT request. Relay backend results",
  "faithfully, read one out in full when the person wants the details, and correct yourself",
  "plainly if one contradicts something you said. If the backend reports a failure, SAY SO",
  "— never invent an explanation for a delay or a result you have not seen.",
].join("\n");

/**
 * What the backend is told, before the certificate's own backend
 * instructions. The exec_typescript contract is the one the OS MCP server
 * hands every client, condensed: a phone-sized voice answer does not need
 * the whole discovery guide, and the docs are one script away.
 */
const BACKEND_BRIEF = [
  "## Voice conversation context",
  "You are the backend of ONE assistant on a live voice call with a person who knows it",
  "well; the frontend voice speaks your result. Transcripts can contain mistakes and later",
  "corrections; use the latest context. Names, paths and identifiers arrive as SPOKEN words",
  '("hello dot md inside the notes folder", "slash agents slash helper", "com dot example',
  'slash report requested"): resolve them to the obvious literal form (notes/hello.md,',
  "/agents/helper, com.example/report-requested) and proceed. When the platform rejects that",
  "literal form and the fix is obvious (a plural, a hyphen, a known prefix such as /agents/),",
  "apply it and continue. Ask for clarification only when two readings would lead to",
  "materially different actions. The transcript can end",
  "mid-request when the person is still talking: do whatever is unambiguous already, and",
  "for the rest say plainly what you still need — the voice sends it on.",
  "",
  "## Task instructions",
  "exec_typescript runs one TypeScript async arrow function, `async (itx) => { ... }`,",
  "against this iterate project; its JSON return value is the tool result. `itx` is the",
  "project's capability tree: docs, streams, repo, workspaces, agents, files, integrations,",
  "and whatever this project mounted. Research before guessing: `await itx.docs.search({ q:",
  '"several related words" })` finds proven examples and declarations, `await itx.__describe()`',
  "(and `__describe()` on any child) inspects a live node, `await itx.docs.typecheck({ code })`",
  "checks a script before a consequential call. Each call is a fresh isolate: fetch data and",
  "RETURN it, look, then decide the next call. Prefer a few small data-first scripts. The",
  "line's own tools (listed below when there are any) are faster than a script: call them",
  "directly.",
  "",
  "## Return the result",
  "Plain spoken sentences: the facts, whether it is done, and what comes next. Two or three",
  "sentences by default; when the person asked for details or a full readout, give all of it",
  "as prose the voice can read aloud. No bullet lists, no code, no URLs. Never claim an",
  "action succeeded unless a tool proved it.",
].join("\n");

const EXEC_TYPESCRIPT_FUNCTION = {
  type: "function",
  name: "exec_typescript",
  description:
    "Execute TypeScript against this iterate project. Pass exactly one async arrow function " +
    "as code: async (itx) => { ... }. Its JSON-serializable return value becomes the tool " +
    "result; a thrown error becomes the tool error. Research unfamiliar calls with " +
    'itx.docs.search({ q: "..." }) and __describe() before guessing a call shape.',
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "One TypeScript async arrow function, e.g. async (itx) => { return await itx.__describe(); }",
      },
    },
    required: ["code"],
    additionalProperties: false,
  },
} as const;

/**
 * How many microphone frames may be held while the provider completes its
 * handshake. Bounded because a handshake that never finishes must not grow a
 * queue without limit. The NEWEST frames are refused once it is full, not the
 * oldest: the start of what somebody said is what makes the rest of it
 * intelligible.
 */
const MAX_HELD_MIC_FRAMES = 500;

/* ========================================================================== */
/* AUDIO                                                                      */
/* ========================================================================== */
/* Base64 is handled here. There is NO rate conversion in this pipeline any
 * more: the device, the stream and GPT-Live all speak 16 kHz PCM16, so every
 * frame crosses as the string it arrived as. */

/** Bytes to base64, chunked so a long buffer cannot blow the argument list. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Base64 back to bytes. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Decoded byte length of a base64 string, WITHOUT decoding it — how the
 * pipeline does its byte arithmetic on audio it never decodes. Also what
 * puts `deltaBytes` on the mirrored provider events.
 */
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length / 4) * 3 - padding;
}

/** All-zero bytes encode to nothing but `A`s (plus padding). */
const ALL_ZERO_BASE64 = /^A+=*$/;

/**
 * The loudest sample in a base64 PCM16 delta, as a non-negative integer.
 * Exact digital silence — the idle stream's whole content — is recognised
 * off the STRING, so the common case never decodes; anything else decodes
 * once (3,200 bytes per 100 ms delta, trivial) and scans.
 */
function peakOfBase64Pcm16(base64: string): number {
  if (base64 === "" || ALL_ZERO_BASE64.test(base64)) return 0;
  const bytes = base64ToBytes(base64);
  let peak = 0;
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const sample = ((bytes[index]! | (bytes[index + 1]! << 8)) << 16) >> 16;
    const magnitude = sample < 0 ? -sample : sample;
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

/* ========================================================================== */
/* CONTRACT                                                                   */
/* ========================================================================== */

/**
 * One step of an itx expression — the platform's persisted-capability shape
 * (apps/os/src/itx/expression.ts): a string is a property read, [method,
 * ...args] is a call. The SDK exports the TYPE (ItxExpressionStep) but not
 * the schema, so the contract mirrors it, reserved-name guard included.
 */
const ItxExpressionStep = z
  .union([z.string(), z.tuple([z.string()], z.unknown())])
  .refine(
    (step) =>
      !["__proto__", "constructor", "prototype"].includes(
        typeof step === "string" ? step : step[0],
      ),
    { message: "itx expressions cannot use reserved property names" },
  );

/**
 * One tool the backend model may call, as data on the birth certificate.
 *
 * `expression` is a walk from the PROJECT ROOT to a function; the model's
 * parsed arguments object is that function's single argument. Persisting an
 * expression persists the NAME of a capability, never its authority — every
 * call re-derives authority from a fresh project session. A tool with NO
 * expression is a name this agent already knows how to be: `hang_up` is the
 * only one — one atomic append of conversation-end-requested, no itx.
 */
const VoiceTool = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    description: z.string(),
    parameters: z.looseObject({}).optional(),
    expression: z.array(ItxExpressionStep).min(1).optional(),
  })
  .refine((tool) => tool.expression !== undefined || tool.name === "hang_up", {
    message: 'a tool with no expression must be a name this agent knows; today that is "hang_up"',
  });

/** Backend overrides — see VoiceBackendInput in setup-options.ts. */
const VoiceBackend = z.strictObject({
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  serviceTier: z.string().optional(),
  instructions: z.string().optional(),
});

/**
 * Everything that outlives the Durable Object holding the socket.
 *
 * Note what is NOT here: no queues, no byte counts, no "is speaking" flag.
 * Reduced state that depends on a buffer no restart can replay is a lie.
 */
const VoiceState = z.object({
  /** Dial this instead of api.openai.com. A test hook; carries no credential. */
  providerBaseUrl: z.string().nullable().default(null),
  /** Model and voice overrides; null takes the package's defaults. */
  providerModel: z.string().nullable().default(null),
  providerVoice: z.string().nullable().default(null),
  /** The voice's persona. Empty means the delegation policy alone. */
  instructions: z.string().default(""),
  /**
   * Classify the answer's audio into mouth shapes and publish the newest one
   * in the runtime bag, where a face-rendering board's 10 Hz poll reads it.
   * Certificate data because it is a fact about the CLIENT.
   */
  visemes: z.boolean().default(false),
  /**
   * Greet on pickup: when the handshake completes, the voice speaks FIRST.
   * Made for push-to-talk clients whose ringing UX promises somebody on the
   * other end; off by default because the boards' open-mic rooms did not ask
   * to be greeted.
   */
  greeting: z.boolean().default(false),
  /** Backend overrides; an empty object is the package's defaults. */
  backend: VoiceBackend.default({}),
  /** Tools the backend may call — see {@link VoiceTool}. */
  tools: z.array(VoiceTool).default([]),
  /**
   * The rolling recap: the newest finished turns, in words, both sides.
   * Folded from the durable transcript events and seeded as history into
   * every fresh provider session, so a re-dial resumes the conversation
   * instead of greeting the listener as a stranger.
   */
  transcript: z
    .array(z.strictObject({ role: z.enum(["listener", "assistant"]), text: z.string() }))
    .default([]),
  call: z
    .object({
      conversationId: z.string(),
      /**
       * When the Stream DO committed the device's most recent input — a mic
       * frame or a button edge. THE DEVICE'S INPUT, not "the last thing
       * anybody said": the agent's own speech leaves no durable event.
       */
      lastDeviceInputAtStreamMs: z.number(),
      /** Decided, not yet done: nothing re-dials a call with this set. */
      endRequested: z.strictObject({ reason: z.string() }).nullable(),
    })
    .nullable()
    .default(null),
});

const EPH = { ephemeral: true as const };

export const VoiceAgentContract = defineProcessorContract({
  /* THE SAME SLUG AS THE FIRST CUT, because the slug IS the contract selector:
   * the live subscription is named for it, and the device speaks these event
   * names already. */
  slug: "voice-agent",
  /* 3.0.0 … 19.0.0: the second cut's history — the flush watermark, the
   * provider abstraction, tools, the split certificate, turn_detection, the
   * face, the colleague (per stream, statuses, notes as events), the durable
   * transcript, greeting, colleaguePath. Read `git log` for the essays. */
  /* 20.0.0: GPT-Live, and only GPT-Live, delegating to one hosted backend.
   * `provider`, `clientTakesTurns`, `turnDetection`, `colleague` and
   * `colleaguePath` leave the certificate (there is one provider; it takes
   * every turn itself; it has no VAD to tune; its backend is a hosted model,
   * not an agent on a desk), `backend` joins it. The colleague's three
   * events become one `backend-reply`. The transcript is grouped from
   * timeline fragments rather than read off item ids. A persisted 19.x fold
   * misnames these; the major bump re-reduces instead of loading it. Clean
   * break as ever. */
  version: "20.0.0",
  description:
    "Runs a GPT-Live voice call in the stream's own Durable Object, one flush watermark deep.",
  stateSchema: VoiceState,
  events: {
    "events.iterate.com/voice-agent/created": {
      description:
        "The voice agent exists on this stream. Existence and nothing else — appended once, " +
        "under a stable key; configuration rides `configured`.",
      payloadSchema: z.strictObject({}),
    },
    "events.iterate.com/voice-agent/configured": {
      description:
        "The agent's whole configuration, REPLACED WHOLESALE: an absent field means its " +
        "default, never 'keep the old value'. Appended by every setup run whose content " +
        "differs. Loose: a key from an older certificate (`clientTakesTurns`, `provider`, " +
        "`colleague`) is ignored rather than refused, so a project worker that re-appends " +
        "last month's shape keeps working.",
      payloadSchema: z.looseObject({
        providerBaseUrl: z.string().optional(),
        providerModel: z.string().optional(),
        providerVoice: z.string().optional(),
        instructions: z.string().optional(),
        visemes: z.boolean().optional(),
        greeting: z.boolean().optional(),
        backend: VoiceBackend.optional(),
        tools: z.array(VoiceTool).optional(),
      }),
    },
    /*
     * THE DEVICE'S HALF, and it is three verbs: the button went down, here is
     * audio, the button came up. Whether a call exists, what it is called and
     * when it ends are the server's. GPT-Live takes every turn itself, so the
     * button edges carry no provider meaning any more — the press is still an
     * interruption of whatever the device is playing, and the opening press
     * still mints the call.
     */
    "events.iterate.com/voice-agent/keepalive": {
      description:
        "The client's call UI is alive, said every ~20s: feeds the idle deadline so a caller " +
        "who waits quietly is not reaped at 60s of mic silence.",
      ...EPH,
      payloadSchema: z.looseObject({ t: z.number().optional() }),
    },
    "events.iterate.com/voice-agent/ptt-start": {
      description:
        "The user began speaking (pressed to talk). Opens a call if one is not already up; " +
        "interrupts whatever the device is playing. DURABLE, alone among the device's verbs: " +
        "the opening press is the one event whose loss strands a human.",
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/voice-agent/mic-frame": {
      description: "One capture frame, numbered by the device that captured it.",
      ...EPH,
      payloadSchema: z.looseObject({
        /** 16 kHz mono PCM16, base64. The only encoding these frames carry. */
        pcm: z.string(),
      }),
    },
    "events.iterate.com/voice-agent/ptt-end": {
      description:
        "The user released the button. Nothing for the provider: it hears the audio stop.",
      ...EPH,
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/voice-agent/call-started": {
      description: "The server opened a call and what it is called.",
      payloadSchema: z.looseObject({ conversationId: z.string() }),
    },
    "events.iterate.com/voice-agent/conversation-accepted": {
      description: "The provider started the session; the call is live.",
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        /** Facet clock: dial to usable, the number a cold call is judged on. */
        handshakeTookMs: z.number(),
        /** Capture held during the handshake and released in one go. */
        heldMicFrames: z.number(),
      }),
    },
    "events.iterate.com/voice-agent/conversation-end-requested": {
      description: "Somebody has decided this call is over, and why.",
      payloadSchema: z.looseObject({ conversationId: z.string(), reason: z.string() }),
    },
    "events.iterate.com/voice-agent/conversation-ended": {
      description: "The call is over.",
      payloadSchema: z.looseObject({ conversationId: z.string(), reason: z.string() }),
    },
    "events.iterate.com/voice-agent/provider-error": {
      description: "The provider reported an error, verbatim.",
      payloadSchema: z.looseObject({ conversationId: z.string(), message: z.string() }),
    },

    /*
     * THE DURABLE TRANSCRIPT — what was actually said, in words, one event
     * per finished turn per side, grouped from the provider's timeline
     * fragments. The fold keeps a bounded recap of these and every new
     * session is seeded with it, and an instrument or an eval can read off
     * the stream what the voice actually said.
     */
    "events.iterate.com/voice-agent/utterance-transcript": {
      description: "The provider's transcription of one finished listener turn.",
      payloadSchema: z.looseObject({ conversationId: z.string(), text: z.string() }),
    },
    "events.iterate.com/voice-agent/answer-transcript": {
      description:
        "The provider's own transcript of one finished spoken answer. `cancelled` marks an " +
        "answer the listener cut off with the button; its text is what was said, not " +
        "necessarily what was heard.",
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        text: z.string(),
        cancelled: z.boolean().optional(),
      }),
    },
    "events.iterate.com/voice-agent/backend-reply": {
      description:
        "The backend model's final text for one delegation, as the voice received it — the " +
        "durable record of what the backend concluded (its function calls are on the " +
        "mirrored provider events and the capability host's script record).",
      payloadSchema: z.looseObject({ conversationId: z.string(), text: z.string() }),
    },
    "events.iterate.com/voice-agent/session-configured": {
      description:
        "The whole briefing one provider session was started with — instructions (bounded), " +
        "the backend model, its tools, whether it was asked to greet — recorded so the " +
        "stream shows how the voice was initialized instead of that being invisible " +
        "session state.",
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        provider: z.string(),
        instructions: z.string(),
        backendModel: z.string(),
        tools: z.array(z.string()),
        greeting: z.boolean(),
      }),
    },

    /*
     * THE SPEAKER FRAMES. Two events, and between them the device's entire buffer
     * policy: play frames in sequence order, and throw away anything at or
     * below a watermark.
     */
    "events.iterate.com/voice-agent/spk-frame": {
      description: "One paced chunk of the answer, numbered within the conversation.",
      ...EPH,
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        /** Monotonic within the call. The only ordering the device trusts. */
        deviceSpeakerFrameSeq: z.number(),
        /** 16 kHz mono PCM16, base64, of no particular length. EMPTY on a
         * frame whose only job is the clear or the end marker. */
        pcm: z.string(),
        /** Throw away everything queued, then play this frame. Bound to a
         * numbered frame so a late one cannot touch a replacing answer. */
        clearSpeakerBufferBeforeFrame: z.boolean().optional(),
        /** Nothing more is coming for this answer. Raised only once the
         * queue behind it is empty, as its own frame when it has to be. */
        lastFrameOfAnswer: z.boolean().optional(),
        /** Facet clock, at the moment this frame was handed to the stream. */
        sentAtFacetMs: z.number(),
      }),
    },
    "events.iterate.com/voice-agent/grok-event": {
      description:
        "The provider's own events for instruments — verbatim, except an audio delta's bytes " +
        "become `deltaBytes`, and the facet's own client commands as `client.<type>`. The " +
        "event keeps its historical name: every instrument reads it by this string.",
      ...EPH,
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        /** Facet clock, at the moment the socket message was parsed. */
        receivedAtFacetMs: z.number(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/voice-agent/created",
    "events.iterate.com/voice-agent/configured",
    "events.iterate.com/voice-agent/call-started",
    "events.iterate.com/voice-agent/conversation-end-requested",
    "events.iterate.com/voice-agent/conversation-ended",
    /* Consumed so the fold sees its own appends and the recap survives an
     * eviction — processEvent has no arm for them on purpose. */
    "events.iterate.com/voice-agent/utterance-transcript",
    "events.iterate.com/voice-agent/answer-transcript",
    /* The live half. Naming them is the whole opt-in — `"*"` never matches an
     * ephemeral event, so nobody gets this firehose by accident. */
    "events.iterate.com/voice-agent/ptt-start",
    "events.iterate.com/voice-agent/mic-frame",
    "events.iterate.com/voice-agent/ptt-end",
    /* The client's "still here" heartbeat — consumed only for the idle
     * stamp; processEvent has no arm for it. */
    "events.iterate.com/voice-agent/keepalive",
  ],
  emits: [
    "events.iterate.com/voice-agent/call-started",
    "events.iterate.com/voice-agent/conversation-accepted",
    "events.iterate.com/voice-agent/conversation-end-requested",
    "events.iterate.com/voice-agent/conversation-ended",
    "events.iterate.com/voice-agent/provider-error",
    "events.iterate.com/voice-agent/utterance-transcript",
    "events.iterate.com/voice-agent/answer-transcript",
    "events.iterate.com/voice-agent/backend-reply",
    "events.iterate.com/voice-agent/session-configured",
    "events.iterate.com/voice-agent/spk-frame",
    "events.iterate.com/voice-agent/grok-event",
  ],
});
export type VoiceAgentContract = typeof VoiceAgentContract;

/**
 * Everything whose lifetime is ONE ANSWER — one run of speech on the
 * provider's continuous output stream. REPLACED WHOLESALE at the onset of
 * speech, instead of hand-reset field by field: an object that is swapped
 * cannot forget a field.
 */
interface Answer {
  /**
   *   "speaking"  the stream is carrying speech (or a pause shorter than
   *               ANSWER_TAIL_SILENCE_MS inside it); deltas go to the queue.
   *   "settled"   between answers: idle silence is dropped at the door.
   */
  phase: "speaking" | "settled";
  /** How much of the answer was RECEIVED from the provider, in audio ms. */
  receivedMs: number;
  /** How much of it was actually HANDED TO THE DEVICE, in audio ms. */
  sentMs: number;
  /** Silence received since the last speech in this answer, in audio ms —
   * the counter that ends it. */
  trailingSilenceMs: number;
  /**
   * The answer is over; say so once the queue is empty. Deliberately NOT
   * "mark the frame that happens to be last": this is a question asked at
   * the drain point, where the answer is always knowable.
   */
  endsWhenQueueDrains: boolean;
  /** Facet clock at this answer's first speech — 0 until one arrives. What
   * the button arm compares a press's `createdAt` against. */
  startedAtFacetMs: number;
}

/** The between-answers state: nothing playing, nothing owed. */
const freshAnswer = (): Answer => ({
  phase: "settled",
  receivedMs: 0,
  sentMs: 0,
  trailingSilenceMs: 0,
  endsWhenQueueDrains: false,
  startedAtFacetMs: 0,
});

/** One speaker's open transcript row: fragments not yet closed by a gap. */
interface TurnBuffer {
  text: string;
  /** Session timeline, both ends. */
  startTimelineMs: number;
  endTimelineMs: number;
  /** The button cut this answer off while it was being spoken. */
  interrupted: boolean;
}

/**
 * Everything whose lifetime is one provider dial.
 *
 * CREATED BEFORE THE AWAITED DIAL — `socket` stays null while the dial is in
 * flight, which is what lets the mic path keep queueing during the handshake
 * — and dropped whole when the dial fails, its socket closes, or the call is
 * hung up. One object where hand-maintained reset lists used to disagree.
 */
interface Dial {
  /** The call this dial serves. A re-dial of the same call is a NEW Dial. */
  readonly conversationId: string;
  /** This dial's own identity, for keys that must not collide with the
   * previous dial of the SAME call — a timestamp is not enough on a virtual
   * clock. */
  readonly dialId: string;
  /** The provider's socket, or null while the dial is still in flight. */
  socket: WebSocket | null;
  /** True once `session.started` arrived and audio may flow. */
  ready: boolean;
  /**
   * Paced answer audio waiting for its turn on the wire, oldest first — as
   * BASE64, the wire's own spelling, so the frame goes out verbatim. NOTHING
   * IN HERE HAS A SEQUENCE NUMBER YET: a number is minted when a frame is
   * HANDED TO THE STREAM, so a hole in the numbering means one thing.
   */
  speakerQueue: string[];
  /** Last speaker-frame sequence number minted, for this call. */
  lastDeviceSpeakerFrameSeq: number;
  /** How far a clear has already been declared, so a repeated press is free. */
  clearedThroughDeviceSpeakerFrameSeq: number;
  /**
   * The next frame out must tell the device to empty its speaker first.
   * TRUE FROM THE MOMENT THE DIAL IS DECIDED: the device may still hold
   * frames from the incarnation that died, numbered higher than the ones
   * about to arrive. Consumed by the sender.
   */
  clearSpeakerBufferBeforeNextFrame: boolean;
  /**
   * When the device will run dry, on the facet clock. The only pacing state:
   * heldBytes = max(0, deviceBufferEmptyAtFacetMs - now) * PCM16_BYTES_PER_MS.
   * A deadline drains implicitly with the clock.
   */
  deviceBufferEmptyAtFacetMs: number;
  /** One sender at a time — PER DIAL. */
  sending: boolean;
  /**
   * The button took the floor while the provider was mid-sentence. The
   * model has not heard the person yet (the press precedes the words), so
   * its speech keeps arriving for a beat; those deltas are dead — the
   * person owns the floor — and are dropped until the stream goes silent
   * once, which is the model itself yielding.
   */
  suppressSpeechUntilSilence: boolean;
  /** The face, when the certificate says something renders one; null costs nothing. */
  face: ReturnType<typeof createFace> | null;
  /**
   * The backend decided the call is over; settle at the drain point, after
   * the goodbye PLAYS. Runtime on purpose: evicted, the idle deadline backstops.
   */
  hangUpAfterAnswerDrains: string | null;
  /** Facet clock when the hang-up was decided — see HANG_UP_GOODBYE_GRACE_MS. */
  hangUpArmedAtFacetMs: number;
  /** Facet clock when the last answer's end marker went out; 0 before any. */
  answerEndedAtFacetMs: number;
  /** This dial has created the stream's capability host (or found it). */
  capabilityHostReady: boolean;
  /** The answer in flight — replaced wholesale at the onset of speech. */
  answer: Answer;
  /**
   * Backend functions this dial is still running. A person who asked for
   * something slow waits in SILENCE — no frames from a push-to-talk client,
   * nothing on the speaker — and the idle deadline must not read that as an
   * abandoned call while the backend is mid-script.
   */
  openBackendCalls: number;
  /** Backend function calls completed on this dial, for the progress notes. */
  backendSteps: number;
  /** Facet clock at the last progress note sent to the voice. */
  lastProgressNoteAtFacetMs: number | null;
  /** Every user transcript fragment of this dial, in order. */
  userTranscript: string;
  /** Facet clock at the last user transcript fragment. */
  lastUserFragmentAtFacetMs: number | null;
  /** How much of `userTranscript` the backend has been given — carried by
   * the delegation itself at creation, forwarded with tool results after. */
  forwardedUserChars: number;
  /**
   * The furthest point on the provider's SESSION TIMELINE seen so far —
   * transcript `end_ms`, delegation `offset_ms`, and the running total of
   * output audio, whichever is largest. What closes a transcript row: a row
   * whose last fragment is TURN_GAP_MS behind the timeline is a finished
   * turn. Output audio is the metronome — it arrives every 100 ms whether or
   * not anything is being said — so rows close without any timer.
   */
  timelineMs: number;
  /** The two open transcript rows, one per speaker; both may be open at once. */
  turns: { user: TurnBuffer | null; assistant: TurnBuffer | null };
}

/** A dial just decided: no socket yet, nothing sent, a clear owed first. */
const freshDial = (conversationId: string): Dial => ({
  conversationId,
  dialId: crypto.randomUUID(),
  socket: null,
  ready: false,
  speakerQueue: [],
  lastDeviceSpeakerFrameSeq: 0,
  clearedThroughDeviceSpeakerFrameSeq: 0,
  clearSpeakerBufferBeforeNextFrame: true,
  deviceBufferEmptyAtFacetMs: 0,
  sending: false,
  suppressSpeechUntilSilence: false,
  face: null,
  hangUpAfterAnswerDrains: null,
  hangUpArmedAtFacetMs: 0,
  answerEndedAtFacetMs: 0,
  capabilityHostReady: false,
  answer: freshAnswer(),
  openBackendCalls: 0,
  backendSteps: 0,
  lastProgressNoteAtFacetMs: null,
  userTranscript: "",
  lastUserFragmentAtFacetMs: null,
  forwardedUserChars: 0,
  timelineMs: 0,
  turns: { user: null, assistant: null },
});

/* ========================================================================== */
/* PROCESSOR                                                                  */
/* ========================================================================== */

export class VoiceAgentProcessor extends StreamProcessor<
  VoiceAgentContract,
  {
    /** The facet clock. Every `...AtFacetMs` in this file comes from here. */
    nowAtFacetMs(): number;
    /** The build this processor is running (`ITERATE_WORKER_VERSION`) —
     * surfaced in the runtime bag so an operator can tell WHICH build a live
     * facet is. */
    buildCacheKey: string;
    /** The only way this processor waits, injected so tests use a fake clock. */
    sleep(ms: number): Promise<void>;
    dialProvider(baseUrl: string | null): Promise<WebSocket | null>;
    /**
     * Open a fresh project itx session, use it, dispose it. Stubs from
     * `env.ITX.get()` must not outlive the invocation that dialed them, so
     * every backend function opens its own — the SDK's own pattern.
     */
    withProject<T>(fn: (project: unknown) => Promise<T>): Promise<T>;
  }
> {
  readonly contract = VoiceAgentContract;

  /* --------------------------------------------------------- runtime state */
  /* Every one of these dies with the incarnation on purpose. Anything that
   * must outlive an eviction is in the fold above. */

  /**
   * The dial this incarnation is running, or null when there is none.
   *
   * ONE DIAL AT A TIME: created synchronously the moment a dial is decided —
   * so two caught-up deliveries cannot open two sockets — and null again
   * when the dial fails, its socket closes, or the call is hung up. Every
   * closure the dial spawns fences itself with `this.#dial !== dial`.
   */
  #dial: Dial | null = null;
  /**
   * Capture that arrived before the provider's handshake finished, oldest
   * first — the device's own base64 strings. NOT ON THE DIAL, because it can
   * start filling before one exists: a revived incarnation holds frames from
   * deliveries that arrive before the caught-up pass re-dials.
   */
  #micQueue: string[] = [];
  /**
   * A call has been ASKED for, and the log has not caught up yet. A board
   * streams microphone frames continuously, so the window between asking
   * and the fold showing a call is never empty — without this every frame in
   * it minted its own conversation.
   */
  #callRequested = false;
  /** When this incarnation last saw a conversation end, for the mint
   * cooldown: the frames a device drained in a call's final ~100 ms arrive
   * BEHIND the obituary and must not mint the call's successor. */
  #conversationEndedAtMs: number | null = null;
  /**
   * The fold's `lastDeviceInputAtStreamMs`, refreshed on every delivery. A
   * MIRROR, never a second source of truth: the idle loop runs between
   * deliveries and has no way to read the fold.
   */
  #lastDeviceInputAtStreamMsMirror = 0;
  /** When the last dial FAILED, for the retry cooldown. */
  #lastDialFailedAtFacetMs = 0;
  /**
   * The mirror's outbox, drained by ONE background flush at a time. The
   * drain swaps this queue out whole and sends it as ONE variadic append, so
   * whatever accumulated while the previous append RPC was in flight
   * coalesces naturally — GPT-Live emits ten audio deltas a second forever.
   */
  #mirrorQueue: {
    payload: Record<string, unknown> & { conversationId: string; receivedAtFacetMs: number };
    append: ProcessEventArgs<VoiceAgentContract>["append"];
  }[] = [];
  #mirrorFlushing = false;

  /* ------------------------------------------------------------------ fold */

  reduce({ state, event }: ReduceArgs<VoiceAgentContract>) {
    const committedAtStreamMs = Date.parse(event.createdAt);
    switch (event.type) {
      case "events.iterate.com/voice-agent/created":
        /* Existence is the event's whole content, and the fold's defaults
         * already ARE the unconfigured agent. */
        return state;

      case "events.iterate.com/voice-agent/configured":
        /* REPLACED WHOLESALE, defaults and all: an absent field resets rather
         * than survives, so a rerun of setup with a shorter config cannot
         * leave last week's tools armed. */
        return {
          ...state,
          providerBaseUrl: event.payload.providerBaseUrl ?? null,
          providerModel: event.payload.providerModel ?? null,
          providerVoice: event.payload.providerVoice ?? null,
          instructions: event.payload.instructions ?? "",
          visemes: event.payload.visemes ?? false,
          greeting: event.payload.greeting ?? false,
          backend: event.payload.backend ?? {},
          tools: event.payload.tools ?? [],
        };

      case "events.iterate.com/voice-agent/call-started":
        /* The id was minted INTO the event rather than here, so this is
         * deterministic under replay. The deadline starts here too: opening a
         * call IS the device saying something. */
        return {
          ...state,
          call: {
            conversationId: event.payload.conversationId,
            lastDeviceInputAtStreamMs: committedAtStreamMs,
            endRequested: null,
          },
        };

      case "events.iterate.com/voice-agent/ptt-start":
      case "events.iterate.com/voice-agent/mic-frame":
      case "events.iterate.com/voice-agent/ptt-end":
      case "events.iterate.com/voice-agent/keepalive":
        /* Their BODIES never reach the fold, but their commit stamps are as
         * durable as any event's, and folding the newest is what makes the
         * idle deadline outlive an eviction. `max` so a redelivered batch
         * cannot walk the deadline backwards. */
        return state.call === null ||
          committedAtStreamMs - state.call.lastDeviceInputAtStreamMs < IDLE_STAMP_STEP_MS
          ? state
          : {
              ...state,
              call: {
                ...state.call,
                lastDeviceInputAtStreamMs: Math.max(
                  state.call.lastDeviceInputAtStreamMs,
                  committedAtStreamMs,
                ),
              },
            };

      case "events.iterate.com/voice-agent/conversation-end-requested":
        /* Decided, not done. The call stays open in the fold until the obituary
         * lands; what changes is that nothing will re-dial it. */
        return state.call === null || state.call.conversationId !== event.payload.conversationId
          ? state
          : { ...state, call: { ...state.call, endRequested: { reason: event.payload.reason } } };

      case "events.iterate.com/voice-agent/conversation-ended":
        return state.call === null || state.call.conversationId !== event.payload.conversationId
          ? state
          : { ...state, call: null };

      case "events.iterate.com/voice-agent/utterance-transcript": {
        if (event.payload.text === "") return state;
        return {
          ...state,
          transcript: foldTranscriptTurn(state.transcript, {
            role: "listener",
            text: event.payload.text,
          }),
        };
      }

      case "events.iterate.com/voice-agent/answer-transcript": {
        if (event.payload.text === "") return state;
        return {
          ...state,
          transcript: foldTranscriptTurn(
            state.transcript,
            { role: "assistant", text: event.payload.text },
            event.payload.cancelled === true
              ? " (the listener interrupted this answer partway)"
              : "",
          ),
        };
      }

      default:
        return state;
    }
  }

  /* ----------------------------------------------------------------- react */

  processEvent(args: ProcessEventArgs<VoiceAgentContract>): undefined {
    const { state, event, delivery, append, runInBackground } = args;

    /* The log has caught up with whichever append we were remembering for it;
     * both memories exist only to cover the gap, so both end here. */
    if (state.call !== null) {
      this.#callRequested = false;
      this.#lastDeviceInputAtStreamMsMirror = state.call.lastDeviceInputAtStreamMs;
    }

    /*
     * THE CAUGHT-UP PASS IS THE RECOVERY, and it runs FIRST. An eventless
     * caught-up delivery is how a revived incarnation learns it owes a call.
     */
    const owedCall = delivery.caughtUp ? state.call : null;
    /*
     * AN OBITUARY NOBODY WROTE IS A CALL NOBODY CAN END. Re-running it here
     * retries a refused or interrupted obituary — idempotent by key.
     */
    if (owedCall !== null && owedCall.endRequested !== null) {
      const { conversationId, endRequested } = owedCall;
      /* The last words of the call — usually the goodbye that decided it —
       * are still an open row; #hangUp fences the close listener out, so
       * this is the one chance to land them durably. */
      if (this.#dial !== null) this.#flushTurns(this.#dial, append, true);
      this.#hangUp();
      args.blockProcessorWhile(() =>
        append({
          type: "events.iterate.com/voice-agent/conversation-ended",
          idempotencyKey: this.idempotencyKey(`ended:${conversationId}`),
          payload: { conversationId, reason: endRequested.reason },
        }),
      );
    }
    if (owedCall !== null && owedCall.endRequested === null) {
      this.#openProviderConnection(owedCall.conversationId, state, append, runInBackground);
    }

    if (event === null) return;

    switch (event.type) {
      case "events.iterate.com/voice-agent/ptt-start":
      case "events.iterate.com/voice-agent/mic-frame":
      case "events.iterate.com/voice-agent/ptt-end": {
        /* NOT DECODED HERE, on purpose. The frame stays the device's own
         * base64 string all the way to the wire. */
        const micB64 =
          event.type === "events.iterate.com/voice-agent/mic-frame" ? event.payload.pcm : null;
        /* An empty frame is a client bug, not audio: the provider rejects
         * "audio/pcm audio must not be empty" and it can open no call. */
        if (micB64 === "") return;
        /* A buried call takes no further input. A NULL call passes — the
         * mint below is what handles the null. */
        if (state.call?.endRequested != null) return;
        if (state.call === null && !this.#callRequested) {
          /*
           * A CALL IS OPENED BY SOMEBODY TALKING, not by anybody asking for
           * one. ONLY SPEECH OPENS A CALL: ephemeral delivery drops and
           * re-delivers, so a lone ptt-end arrives here, and a call minted
           * for it would be a zombie squatting out the idle deadline.
           */
          if (event.type === "events.iterate.com/voice-agent/ptt-end") return;
          /*
           * AND NOT THE LAST CALL'S DYING BREATH. A device drains its mic
           * queue for ~100 ms after the far end hangs up; those frames land
           * on a null call and minted its successor within 171 ms.
           */
          if (
            this.#conversationEndedAtMs !== null &&
            this.deps.nowAtFacetMs() - this.#conversationEndedAtMs < 1500
          ) {
            return;
          }
          /*
           * AND NOT A PRESS FROM ANOTHER ERA. ptt-start is durable, so a
           * half-hour-old press replayed after a long facet outage must not
           * mint a call to an empty room. The device re-presses every 3s
           * while it still wants the call, so 30s of validity loses nobody.
           */
          if (event.type === "events.iterate.com/voice-agent/ptt-start") {
            const pressedAtStreamMs = Date.parse(event.createdAt);
            if (
              Number.isFinite(pressedAtStreamMs) &&
              this.deps.nowAtFacetMs() - pressedAtStreamMs > 30_000
            ) {
              return;
            }
          }
          const conversationId = `conv_${crypto.randomUUID()}`;
          this.#callRequested = true;
          /* THE IDLE DEADLINE ARMS AT MINT: opening a call IS the device's
           * initial input. `max` so a mint can never walk a fresher stamp back. */
          this.#lastDeviceInputAtStreamMsMirror = Math.max(
            this.#lastDeviceInputAtStreamMsMirror,
            this.deps.nowAtFacetMs(),
          );
          /* The one append the whole call hangs off: if it silently fails,
           * #callRequested can never clear. The cursor waits the one write;
           * a refusal un-asks. */
          args.blockProcessorWhile(() =>
            append({
              type: "events.iterate.com/voice-agent/call-started",
              idempotencyKey: this.idempotencyKey(`call:${conversationId}`),
              payload: { conversationId },
            }).catch(() => {
              this.#callRequested = false;
            }),
          );
          /*
           * DIAL NOW, NOT WHEN THE LOG AGREES. Waiting for the append to come
           * back and be folded put a full stream round trip in front of every
           * first word — measured at 7.4 seconds. And NO return: the frame
           * that opened the call falls through to the hold site below.
           */
          this.#openProviderConnection(conversationId, state, append, runInBackground);
        }

        /*
         * THE BUTTON IS AN INTERRUPTION of whatever the device is playing.
         * GPT-Live will stop itself the moment it hears the person, but the
         * press comes first and the device holds a beat of audio; the clear
         * makes the interruption feel instant. Guarded on the FOLD's call,
         * not just the dial: the press that MINTED the call barges nothing.
         */
        if (event.type === "events.iterate.com/voice-agent/ptt-start" && state.call !== null) {
          const dial = this.#dial;
          /* AND NOT THE DIAL'S OWN ECHO. The device re-presses every 3s while
           * it still wants the call, stamped BEFORE any answer existed; the
           * delivery hands them over seconds late. An interruption is a
           * press stamped AFTER the answer it means to stop began. The 250ms
           * guard band absorbs stream-vs-facet wall-clock skew. */
          const pressedAtStreamMs = Date.parse(event.createdAt);
          const answerStartedAtFacetMs = dial?.answer.startedAtFacetMs ?? 0;
          const pressIsOpeningEcho =
            Number.isFinite(pressedAtStreamMs) &&
            answerStartedAtFacetMs > 0 &&
            pressedAtStreamMs < answerStartedAtFacetMs - 250;
          if (dial !== null && !pressIsOpeningEcho) {
            this.#bargeAnswer(dial, this.deps.nowAtFacetMs(), append);
          }
        }

        if (micB64 !== null) {
          const dial = this.#dial;
          if (dial !== null && dial.ready && dial.socket !== null) {
            this.#sendMicAudio(dial.socket, micB64);
          } else if (this.#micQueue.length < MAX_HELD_MIC_FRAMES) {
            this.#micQueue.push(micB64);
          }
        }
        /* ptt-end says nothing to the provider: it hears the audio stop, and
         * measured from this Mac it answered 475 ms after a button-release-
         * shaped stop with no frames behind it. */
        return;
      }

      /* There is NO conversation-end-requested arm. reduce folds the decision
       * before delivery reaches this switch, so the caught-up pass above has
       * already hung up and written the obituary on the very delivery that
       * carried the event. */

      case "events.iterate.com/voice-agent/conversation-ended": {
        /*
         * A DEVICE-appended obituary (the hang-up button) takes this path
         * without any end-requested ever existing, so the caught-up
         * settlement never runs, and without this arm the DIAL stays alive:
         * a zombie provider socket squatting `#dial`, blocking every new dial
         * until the idle tick finally kills it (measured on HAVPE 2026-08-19).
         * The fence is the DIAL's own conversation, which a stale obituary
         * cannot name. And the device is silenced NOW.
         */
        this.#conversationEndedAtMs = this.deps.nowAtFacetMs();
        const dial = this.#dial;
        if (dial !== null && dial.conversationId === event.payload.conversationId) {
          this.#flushTurns(dial, append, true);
          this.#clearDeviceSpeaker(dial, this.deps.nowAtFacetMs(), append);
          this.#hangUp();
        }
        return;
      }

      default:
        return;
    }
  }

  /**
   * Open a provider connection for this call, now.
   *
   * WHY THIS IS CALLED FROM TWO PLACES. The mint dials immediately (waiting
   * for the log to deliver `call-started` back put seven seconds in front of
   * the first word); the caught-up path is how a REVIVED incarnation learns
   * it owes a call nobody is dialling. The dial object's synchronous
   * creation is what makes the two callers safe together.
   */
  #openProviderConnection(
    conversationId: string,
    state: ProcessEventArgs<VoiceAgentContract>["state"],
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    if (this.#dial !== null) return;
    /* The one choke point both callers share, so a dead provider cannot be
     * re-dialled at frame cadence. */
    if (this.deps.nowAtFacetMs() - this.#lastDialFailedAtFacetMs < DIAL_RETRY_COOLDOWN_MS) return;
    /* CREATED BEFORE THE AWAITED DIAL, so a second caller finds `#dial`
     * taken and the mic path queues for the whole handshake. */
    const dial = freshDial(conversationId);
    if (state.visemes) dial.face = createFace();
    this.#dial = dial;
    const dialStartedAtFacetMs = this.deps.nowAtFacetMs();
    runInBackground(async () => {
      /* A dial can REJECT (DNS, TLS), not just refuse — and an uncaught
       * throw here was measured as sixty seconds of dead air. A throw IS a
       * refusal, and both failures share one exit. */
      let socket: WebSocket | null = null;
      let failure = "the provider refused the connection";
      try {
        socket = await this.deps.dialProvider(state.providerBaseUrl);
      } catch (error) {
        failure = `the provider dial failed: ${String(error).slice(0, 200)}`;
      }
      if (socket === null) {
        this.#lastDialFailedAtFacetMs = this.deps.nowAtFacetMs();
        if (this.#dial === dial) this.#dial = null;
        await this.#requestEnd(conversationId, "dial-failed", failure, append);
        return;
      }
      if (this.#dial !== dial) {
        /* Hung up while dialling: adopting the socket would resurrect a
         * buried conversation. */
        try {
          socket.close();
        } catch {
          /* Already gone. */
        }
        return;
      }
      dial.socket = socket;

      /*
       * THE HANDSHAKE GETS A DEADLINE, because the idle backstop cannot see
       * this wedge: an open-mic board's frames keep the idle stamp fresh
       * while the un-ready dial holds them. Nulling #dial first fences the
       * close listener out; the obituary says what actually happened.
       */
      this.runInBackground(async () => {
        await this.deps.sleep(HANDSHAKE_DEADLINE_MS);
        if (this.#dial !== dial || dial.ready) return;
        this.#dial = null;
        try {
          socket.close();
        } catch {
          /* Already gone. */
        }
        await this.#requestEnd(
          conversationId,
          "handshake-timeout",
          `the provider handshake did not complete within ${HANDSHAKE_DEADLINE_MS}ms`,
          append,
        );
      });

      /*
       * THE THIRD SWITCH, AND WHY IT IS NOT A STREAM EVENT. Everything else
       * in this file reaches `processEvent` by being appended. The provider's
       * messages do not, and the reason is measured rather than stylistic:
       * ephemeral delivery coalesces, delivering in clumps seconds late.
       * Routing an audio delta through it would put a full stream round trip
       * in front of every word. The provider's timeline is still appended
       * for instruments — just not waited for.
       */
      socket.addEventListener("message", (message: MessageEvent) => {
        /*
         * A SUPERSEDED SOCKET IS STILL A TALKING SOCKET, and this is the
         * fence: without it a late message from an abandoned socket marked
         * the call ready again and emptied the microphone queue into a dead
         * connection. The fence is the DIAL's identity.
         */
        if (this.#dial !== dial) return;
        if (typeof message.data !== "string") return;
        let live: Record<string, unknown>;
        try {
          live = JSON.parse(message.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = String(live.type ?? "");
        const receivedAtFacetMs = this.deps.nowAtFacetMs();
        this.#forwardProviderEvent(dial, live, type, receivedAtFacetMs, append);
        this.#onLiveEvent(
          dial,
          live,
          type,
          receivedAtFacetMs,
          dialStartedAtFacetMs,
          state,
          append,
          runInBackground,
        );
        /* THE METRONOME: every message — the 10 Hz audio stream above all —
         * moves the session timeline, and a transcript row TURN_GAP_MS behind
         * it is a finished turn. No timer anywhere. */
        this.#flushTurns(dial, append, false);
      });

      socket.addEventListener("close", () => {
        if (this.#dial !== dial) return;
        this.#dial = null;
        this.#flushTurns(dial, append, true);
        this.runInBackground(() =>
          this.#requestEnd(conversationId, "socket-closed", "the provider's socket closed", append),
        );
      });

      /*
       * THE SESSION STARTS THE MOMENT THE SOCKET IS OURS. There is no
       * `session.created` to wait for: `session.start` is the first message,
       * carrying the model, the audio format, the voice, the instructions,
       * the seeded history and the backend — everything a fresh session needs
       * to be this stream's assistant instead of a stranger.
       */
      this.#startSession(dial, state, append);
    });

    /*
     * THE IDLE COUNTDOWN ARMS THE MOMENT THE DIAL IS DECIDED, so a dial that
     * never resolves still gets buried. A SELF-RESCHEDULING TICK CHAIN, not a
     * loop: one background closure that settles only when the call ends is
     * indistinguishable from a wedge to the facet keepalive's busy-refire
     * detector.
     */
    const idleTick = async (): Promise<void> => {
      await this.deps.sleep(IDLE_TICK_MS);
      if (this.#dial !== dial) return;
      const nowAtFacetMs = this.deps.nowAtFacetMs();
      /*
       * IDLE SINCE THE LAST THING THAT HAPPENED, whichever end it happened
       * at. The durable stamp records only the DEVICE's input; a listener
       * hearing out a long answer sends nothing, so finishing an answer
       * counts too — `deviceBufferEmptyAtFacetMs` is when this end stopped.
       * In-memory ON PURPOSE: after an eviction nothing was said, and the
       * durable stamp alone still bites.
       */
      const lastActivityAtFacetMs = Math.max(
        this.#lastDeviceInputAtStreamMsMirror,
        dial.deviceBufferEmptyAtFacetMs,
      );
      if (nowAtFacetMs - lastActivityAtFacetMs < IDLE_TIMEOUT_MS) {
        this.runInBackground(idleTick);
        return;
      }
      /* Still holding audio it has not handed over yet, or still running
       * something the person asked for: not idle by any reading, whatever
       * the clocks say. */
      if (dial.speakerQueue.length > 0 || dial.openBackendCalls > 0) {
        this.runInBackground(idleTick);
        return;
      }
      await this.#requestEnd(
        conversationId,
        "idle",
        `no input from the device for ${IDLE_TIMEOUT_MS / 1000}s`,
        append,
      );
    };
    this.runInBackground(idleTick);
  }

  /* ---------------------------------------------------------- the session */

  /**
   * Compose and send `session.start`: the persona plus the delegation policy
   * as instructions, the fold's transcript as seeded HISTORY (typed messages
   * — a reconnect is invisible to the listener), and the backend with its
   * brief and functions. Recorded durably as `session-configured`, because a
   * session nobody can inspect later was how "why did it say hi like a
   * stranger?" went unanswered.
   */
  #startSession(
    dial: Dial,
    state: ProcessEventArgs<VoiceAgentContract>["state"],
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    if (dial.socket === null) return;
    const instructions = [
      ...(state.instructions === "" ? [] : [state.instructions]),
      LIVE_DELEGATION_POLICY,
    ].join("\n\n");

    /* The recap: a fresh provider session is a stranger, and the fold
     * remembers so it does not have to be. As the history it is. */
    const input = state.transcript.map((turn) =>
      turn.role === "listener"
        ? {
            type: "message" as const,
            role: "user" as const,
            content: [{ type: "input_text" as const, text: turn.text }],
          }
        : {
            type: "message" as const,
            role: "assistant" as const,
            content: [{ type: "output_text" as const, text: turn.text }],
          },
    );

    const backendTools = [
      EXEC_TYPESCRIPT_FUNCTION,
      ...state.tools.map(({ name, description, parameters }) => ({
        type: "function" as const,
        name,
        description,
        parameters: parameters ?? { type: "object", properties: {} },
      })),
    ];
    const backendModel = state.backend.model ?? BACKEND.model;
    const delegation = {
      type: "responses",
      responses: {
        model: backendModel,
        instructions: [
          BACKEND_BRIEF,
          ...(state.tools.length > 0
            ? [
                "## Tools this line offers\n" +
                  state.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n"),
              ]
            : []),
          ...(state.backend.instructions ? [state.backend.instructions] : []),
        ].join("\n\n"),
        tools: backendTools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        reasoning: { effort: state.backend.reasoningEffort ?? BACKEND.reasoningEffort },
        service_tier: state.backend.serviceTier ?? BACKEND.serviceTier,
      },
    };

    this.runInBackground(() =>
      append({
        type: "events.iterate.com/voice-agent/session-configured",
        idempotencyKey: this.idempotencyKey(`session-configured:${dial.dialId}`),
        payload: {
          conversationId: dial.conversationId,
          provider: "gpt-live",
          instructions: instructions.slice(0, 8_000),
          backendModel,
          tools: backendTools.map((tool) => tool.name),
          greeting: state.greeting,
        },
      }),
    );
    dial.socket.send(
      JSON.stringify({
        type: "session.start",
        event_id: `start_${dial.dialId}`,
        session: {
          model: state.providerModel ?? LIVE.model,
          instructions,
          ...(input.length > 0 && { input }),
          audio: {
            format: { type: "audio/pcm", rate: LIVE.rate },
            output: { voice: state.providerVoice ?? LIVE.voice },
          },
          delegation,
        },
      }),
    );
  }

  /** The provider's message switch. Every arm returns. */
  #onLiveEvent(
    dial: Dial,
    live: Record<string, unknown>,
    type: string,
    receivedAtFacetMs: number,
    dialStartedAtFacetMs: number,
    state: ProcessEventArgs<VoiceAgentContract>["state"],
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    const { conversationId } = dial;
    switch (type) {
      case "session.started": {
        /* Usable. Everything the handshake made us hold goes now. */
        dial.ready = true;
        const heldMicFrames = this.#micQueue.length;
        for (const held of this.#micQueue) this.#sendMicAudio(dial.socket!, held);
        this.#micQueue = [];
        this.runInBackground(() =>
          append({
            type: "events.iterate.com/voice-agent/conversation-accepted",
            /* PER DIAL, not per conversation: a call rescued after an
             * eviction handshakes a second time and its numbers are its own. */
            idempotencyKey: this.idempotencyKey(`accepted:${conversationId}:${dial.dialId}`),
            payload: {
              conversationId,
              handshakeTookMs: receivedAtFacetMs - dialStartedAtFacetMs,
              heldMicFrames,
            },
          }),
        );
        /*
         * THE PICKUP GREETING. Only when nobody has spoken yet: a caller
         * already mid-sentence came to talk, not to be welcomed over. The
         * provider's own recipe — one instructions append asking it to
         * speak first.
         */
        if (state.greeting && heldMicFrames === 0) {
          this.#sendControl(
            dial,
            {
              type: "session.instructions.append",
              event_id: `greeting_${dial.dialId}`,
              delegation_id: null,
              content:
                "The call just connected and the person is listening. Greet them now — say hi " +
                "first, in a few words, then wait for them to speak.",
            },
            append,
          );
        }
        return;
      }

      case "session.output_audio.delta": {
        if (typeof live.delta !== "string") return;
        this.#onOutputAudio(dial, live.delta, receivedAtFacetMs, append, runInBackground);
        return;
      }

      case "session.input_transcript.delta":
      case "session.output_transcript.delta": {
        if (typeof live.delta !== "string") return;
        const speaker = type === "session.input_transcript.delta" ? "user" : "assistant";
        if (speaker === "user") {
          dial.userTranscript += live.delta;
          dial.lastUserFragmentAtFacetMs = receivedAtFacetMs;
        }
        const startTimelineMs = typeof live.start_ms === "number" ? live.start_ms : dial.timelineMs;
        const endTimelineMs = typeof live.end_ms === "number" ? live.end_ms : startTimelineMs;
        dial.timelineMs = Math.max(dial.timelineMs, endTimelineMs);
        const open = dial.turns[speaker];
        if (open !== null && startTimelineMs - open.endTimelineMs >= TURN_GAP_MS) {
          /* A fragment landing well after the row's last: the row was a
           * finished turn (the metronome usually closes it first; this is
           * the fragment arriving faster than the audio). */
          this.#closeTurn(dial, speaker, append);
        }
        const row = dial.turns[speaker];
        if (row === null) {
          dial.turns[speaker] = {
            text: live.delta,
            startTimelineMs,
            endTimelineMs,
            interrupted: false,
          };
        } else {
          row.text += live.delta;
          row.endTimelineMs = Math.max(row.endTimelineMs, endTimelineMs);
        }
        return;
      }

      case "session.delegation.created":
        /* The voice handed something to the backend; the provider runs it
         * with the transcript so far. What the person says AFTER this goes
         * with the tool results (see USER_STILL_TALKING_MS). */
        dial.forwardedUserChars = dial.userTranscript.length;
        if (typeof live.offset_ms === "number") {
          dial.timelineMs = Math.max(dial.timelineMs, live.offset_ms);
        }
        return;

      case "response.event": {
        /*
         * THE BACKEND'S STREAM, nested. Dispatch on the inner type and
         * tolerate the rest: lifecycle snapshots arrive with `output: []`
         * deliberately, so the function calls are read off
         * `response.output_item.done`, whose finished item carries
         * `call_id`, `name` and `arguments` together.
         *
         * The provider's JSON is untyped here (the message was parsed as a
         * bare record); the assertions below only name the shape the code
         * then checks field by field with typeof/Array.isArray, so a message
         * that is not that shape is ignored rather than trusted.
         */
        const inner = (live.event ?? {}) as Record<string, unknown>;
        if (String(inner.type ?? "") !== "response.output_item.done") return;
        const item = (inner.item ?? {}) as Record<string, unknown>;
        if (item.type === "function_call" && typeof item.call_id === "string") {
          this.#runBackendFunction(
            dial,
            item.call_id,
            String(item.name ?? ""),
            String(item.arguments ?? "{}"),
            state,
            append,
            runInBackground,
          );
          return;
        }
        if (item.type === "message") {
          /* The backend's final words, on the record. The voice already has
           * the text through the provider. */
          const content = Array.isArray(item.content)
            ? (item.content as Record<string, unknown>[])
            : [];
          const text = content
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .join("")
            .trim();
          if (text === "") return;
          this.runInBackground(() =>
            append({
              type: "events.iterate.com/voice-agent/backend-reply",
              idempotencyKey: this.idempotencyKey(
                `backend-reply:${dial.dialId}:${String(item.id ?? crypto.randomUUID())}`,
              ),
              payload: { conversationId, text },
            }),
          );
        }
        return;
      }

      case "session.closed": {
        /* The provider finalized the session — expired, a safety filter, a
         * lost upstream. The socket close that follows shares the key class,
         * so whichever lands first writes the reason. */
        this.#flushTurns(dial, append, true);
        this.runInBackground(() =>
          this.#requestEnd(
            conversationId,
            "socket-closed",
            `the provider closed the session (${String(live.reason ?? "unknown")})`,
            append,
          ),
        );
        return;
      }

      case "error":
        this.runInBackground(() =>
          append({
            type: "events.iterate.com/voice-agent/provider-error",
            payload: {
              conversationId,
              message: JSON.stringify(live.error ?? live).slice(0, 2_000),
            },
          }),
        );
        return;

      default:
        /* Acknowledgements (`*.appended`), `session.usage.updated`, `info`:
         * in the mirror already, nothing to act on. */
        return;
    }
  }

  /**
   * One 100 ms delta of the provider's CONTINUOUS output stream.
   *
   * THE STREAM NEVER STOPS, so "is the voice speaking" is read off the audio
   * itself: a delta is speech or it is silence. Idle silence is dropped at
   * the door — the device's ring being empty IS silence, and the downlink
   * carries speech only. Speech opens an answer (a fresh Answer, the face
   * told, the pacer started); silence inside an answer rides along up to
   * ANSWER_TAIL_SILENCE_MS so the natural pauses play; silence past that
   * ends the answer, and the pacer marks `lastFrameOfAnswer` at the drain.
   */
  #onOutputAudio(
    dial: Dial,
    delta: string,
    receivedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    const deltaMs = base64ByteLength(delta) / PCM16_BYTES_PER_MS;
    /* The metronome: every delta advances the session timeline. */
    dial.timelineMs += deltaMs;
    const speaking = peakOfBase64Pcm16(delta) >= SPEECH_PEAK;

    if (dial.suppressSpeechUntilSilence) {
      /* The button took the floor and the model has not yielded yet: its
       * last words are dead air. The first silent delta is the model
       * yielding, and lifts the suppression. */
      if (speaking) return;
      dial.suppressSpeechUntilSilence = false;
    }

    if (dial.answer.phase === "settled") {
      if (!speaking) return;
      /* THE ONSET: a new answer, replaced wholesale. */
      dial.answer = freshAnswer();
      dial.answer.phase = "speaking";
      dial.answer.startedAtFacetMs = receivedAtFacetMs;
      dial.face?.answerStarted();
    } else if (speaking) {
      dial.answer.trailingSilenceMs = 0;
    } else {
      dial.answer.trailingSilenceMs += deltaMs;
      if (dial.answer.trailingSilenceMs >= ANSWER_TAIL_SILENCE_MS) {
        /* THE ANSWER IS OVER, and the device does have to be told: silence
         * on the wire is indistinguishable from a provider taking its time,
         * so a client waiting for the end of a turn waits for ever. Asked at
         * the DRAIN POINT so the marker cannot overtake the audio. */
        dial.answer.phase = "settled";
        dial.answer.endsWhenQueueDrains = true;
        this.#sendSpeakerAudio(dial, append, runInBackground);
        return;
      }
    }

    dial.answer.receivedMs += deltaMs;
    /* The provider's 16 kHz bytes ARE the pipeline's bytes, so the answer
     * stays base64 end to end. A delta that fits the device's ceiling goes
     * out WHOLE — GPT-Live's 100 ms delta is exactly that ceiling, and
     * slicing it at a group boundary would leave a two-byte tail frame
     * behind every one. A longer delta is cut at group boundaries without
     * decoding; anything unaligned (atob tolerates ragged base64 the device
     * would play as noise) decodes and re-cuts. */
    if (base64ByteLength(delta) <= MAX_SPEAKER_PAYLOAD_BYTES) {
      dial.speakerQueue.push(delta);
    } else if (delta.length % 4 === 0) {
      for (let cut = 0; cut < delta.length; cut += IDENTITY_SLICE_B64_CHARS) {
        dial.speakerQueue.push(delta.slice(cut, cut + IDENTITY_SLICE_B64_CHARS));
      }
    } else {
      const pcm16 = base64ToBytes(delta);
      for (let cut = 0; cut < pcm16.length; cut += MAX_SPEAKER_PAYLOAD_BYTES) {
        dial.speakerQueue.push(
          bytesToBase64(
            pcm16.subarray(cut, Math.min(cut + MAX_SPEAKER_PAYLOAD_BYTES, pcm16.length)),
          ),
        );
      }
    }
    this.#sendSpeakerAudio(dial, append, runInBackground);
  }

  /* ------------------------------------------------------------ transcript */

  /**
   * Close every open row whose last fragment is TURN_GAP_MS behind the
   * timeline — or every row, when the call is ending and no more fragments
   * can come.
   */
  #flushTurns(
    dial: Dial,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    force: boolean,
  ): void {
    for (const speaker of ["user", "assistant"] as const) {
      const row = dial.turns[speaker];
      if (row === null) continue;
      if (force || dial.timelineMs - row.endTimelineMs >= TURN_GAP_MS) {
        this.#closeTurn(dial, speaker, append);
      }
    }
  }

  /**
   * One finished turn leaves one durable event carrying its words — the
   * fold's recap and the stream's only readable record hang off these. Keyed
   * on the dial and the row's start, so a redelivered close cannot write a
   * turn twice.
   */
  #closeTurn(
    dial: Dial,
    speaker: "user" | "assistant",
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    const row = dial.turns[speaker];
    dial.turns[speaker] = null;
    if (row === null) return;
    const text = row.text.replace(/\s+/g, " ").trim();
    if (text === "") return;
    const key = `live-turn:${dial.dialId}:${speaker}:${String(row.startTimelineMs)}`;
    this.runInBackground(() =>
      speaker === "user"
        ? append({
            type: "events.iterate.com/voice-agent/utterance-transcript",
            idempotencyKey: this.idempotencyKey(key),
            payload: { conversationId: dial.conversationId, text },
          })
        : append({
            type: "events.iterate.com/voice-agent/answer-transcript",
            idempotencyKey: this.idempotencyKey(key),
            payload: {
              conversationId: dial.conversationId,
              text,
              ...(row.interrupted && { cancelled: true }),
            },
          }),
    );
  }

  /* ---------------------------------------------------------- the mirror */

  /**
   * The provider's timeline, for instruments — WITHOUT the audio in it. The
   * delta rides as its LENGTH: the shape of the answer stays visible and the
   * bytes go once, on `spk-frame`. GPT-Live emits an audio delta every 100 ms
   * for the life of the call, so the mirror would otherwise carry the whole
   * output stream twice.
   */
  #forwardProviderEvent(
    dial: Dial,
    live: Record<string, unknown>,
    type: string,
    receivedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    if (type === "session.output_audio.delta") {
      const { delta, ...rest } = live;
      this.#appendMirror(
        {
          ...rest,
          deltaBytes: base64ByteLength(typeof delta === "string" ? delta : ""),
          conversationId: dial.conversationId,
          receivedAtFacetMs,
        },
        append,
      );
    } else {
      this.#appendMirror(
        { ...live, conversationId: dial.conversationId, receivedAtFacetMs },
        append,
      );
    }
  }

  /** Put one payload in the mirror — see `#mirrorQueue`. */
  #appendMirror(
    payload: Record<string, unknown> & { conversationId: string; receivedAtFacetMs: number },
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    this.#mirrorQueue.push({ payload, append });
    if (this.#mirrorFlushing) return;
    this.#mirrorFlushing = true;
    this.runInBackground(async () => {
      /* The flag clears in a finally around the WHOLE loop: a rejected
       * append loses only its own batch, never the mirror. */
      try {
        while (this.#mirrorQueue.length > 0) {
          const batch = this.#mirrorQueue;
          this.#mirrorQueue = [];
          await batch[0]!.append(
            ...batch.map(({ payload }) => ({
              type: "events.iterate.com/voice-agent/grok-event" as const,
              payload,
            })),
          );
        }
      } finally {
        this.#mirrorFlushing = false;
      }
    });
  }

  /* ------------------------------------------------------------- the mic */

  /**
   * The device's base64 goes to the wire as it came — same rate, same bytes,
   * no decode — with ONE repair: padding. The kit firmware encodes RFC 4648
   * unpadded (640 bytes → 854 characters; voicelab_stream.c), Node's decoder
   * never minded, and GPT-Live's rejects every frame: `audio must be
   * base64-encoded audio/pcm: illegal base64 data at input byte 852`
   * (measured 2026-09-11, a Mac talk run heard nothing back). The ONE site
   * that knows the provider's spelling of "here is audio".
   */
  #sendMicAudio(socket: WebSocket, b64: string): void {
    const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    socket.send(JSON.stringify({ type: "session.input_audio.append", audio: padded }));
  }

  /**
   * One obituary shape for every reason this processor decides a call is
   * over. The key class scopes the dedupe: a retried decision collides with
   * itself and never with a different reason's.
   */
  async #requestEnd(
    conversationId: string,
    keyClass: "dial-failed" | "handshake-timeout" | "socket-closed" | "idle" | "hang-up",
    reason: string,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): Promise<void> {
    await append({
      type: "events.iterate.com/voice-agent/conversation-end-requested",
      idempotencyKey: this.idempotencyKey(`${keyClass}:${conversationId}`),
      payload: { conversationId, reason },
    });
  }

  /* ----------------------------------------------------------- the backend */

  /**
   * Run one function the backend called, off the frame path, and ALWAYS
   * answer it: a function call is a debt, and silence is the one forbidden
   * result. `exec_typescript` runs on the project's own capability host; a
   * certificate tool walks its itx expression; `hang_up` is the base case.
   * The output goes back as a Responses item and the response is continued —
   * the documented two-step, which the provider does not do on its own.
   */
  #runBackendFunction(
    dial: Dial,
    callId: string,
    name: string,
    rawArguments: string,
    state: ProcessEventArgs<VoiceAgentContract>["state"],
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    /* The backend's arguments are JSON text; parsed, they are whatever the
     * model produced, so every read below narrows with typeof first and the
     * assertions only spell the property being looked for. */
    let modelArgs: unknown = rawArguments;
    try {
      modelArgs = JSON.parse(rawArguments === "" ? "{}" : rawArguments);
    } catch {
      /* Raw it is; the function decides what that means. */
    }
    dial.openBackendCalls += 1;
    runInBackground(async () => {
      let output: string;
      const tool = state.tools.find((candidate) => candidate.name === name);
      /* hang_up ends the delegation: its result is what lets the voice say
       * goodbye inside HANG_UP_GOODBYE_GRACE_MS, so it is never held for the
       * rest of a request and nothing is forwarded with it. */
      const holdForTheRestOfTheRequest = !(tool !== undefined && tool.expression === undefined);
      try {
        const timedOut = Symbol("backend function deadline");
        let work: Promise<unknown>;
        if (name === EXEC_TYPESCRIPT_FUNCTION.name) {
          const code =
            typeof (modelArgs as { code?: unknown })?.code === "string"
              ? (modelArgs as { code: string }).code
              : String(modelArgs ?? "");
          work = this.deps.withProject(async (project) => {
            /* Asserted, not typed: withProject hands over the guest's itx
             * untyped (the generated client type lives in apps/os and a
             * package cannot import it); a wrong assertion fails loudly at
             * the RPC boundary. The same runScript the OS MCP server's
             * exec_typescript uses, on THIS STREAM's own capability host —
             * the guest's itx is scoped to the voice stream, so the script
             * runs are journaled beside the transcript. A voice stream is
             * not an agent and nobody created its host, so the first run of
             * each dial creates it first — idempotent (measured on preview:
             * a second create is a no-op), one extra RPC per dial, and no
             * retry that could run a failed script twice. */
            const typed = project as {
              capabilityHost: {
                create(): Promise<unknown>;
                runScript(code: string): Promise<{ result: unknown }>;
              };
            };
            if (!dial.capabilityHostReady) {
              await typed.capabilityHost.create();
              dial.capabilityHostReady = true;
            }
            return (await typed.capabilityHost.runScript(code)).result;
          });
        } else if (tool !== undefined && tool.expression === undefined) {
          /* THE BASE CASE, NOT A REGISTRY: hanging up is one atomic append of
           * conversation-end-requested, deferred to the drain point so the
           * goodbye — spoken AFTER this call returns — gets PLAYED, not cut.
           * See HANG_UP_GOODBYE_GRACE_MS for how the drain point knows. */
          dial.hangUpAfterAnswerDrains = "the backend hung up";
          dial.hangUpArmedAtFacetMs = this.deps.nowAtFacetMs();
          /* Nothing may be playing, so nothing else would start the pacer
           * that settles this: kick it once the grace is up, whatever the
           * stream did meanwhile (a spoken goodbye settles it sooner). */
          runInBackground(async () => {
            await this.deps.sleep(HANG_UP_GOODBYE_GRACE_MS);
            if (this.#dial !== dial) return;
            this.#sendSpeakerAudio(dial, append, runInBackground);
          });
          work = Promise.resolve({ status: "hanging up once the goodbye finishes playing" });
        } else if (tool !== undefined) {
          const expression = tool.expression!;
          work = this.deps.withProject(async (project) => {
            /* The platform's own walk (apps/os/src/itx/expression.ts):
             * reads pipeline, calls invoke. The expression walks an untyped
             * capability tree, so each step's target is asserted as an
             * object and the final value checked to be a function — a wrong
             * step throws here and the backend hears it. */
            let receiver: unknown;
            let value: unknown = project;
            for (const step of expression) {
              const target = (await value) as object;
              if (typeof step === "string") {
                receiver = target;
                value = Reflect.get(target, step);
              } else {
                const [method, ...bound] = step;
                receiver = undefined;
                value = Reflect.apply(
                  Reflect.get(target, method) as (...args: unknown[]) => unknown,
                  target,
                  bound,
                );
              }
            }
            const fn = await value;
            if (typeof fn !== "function") {
              throw new Error(`the "${tool.name}" expression did not end at a function`);
            }
            return (await Reflect.apply(fn, receiver, [modelArgs])) as unknown;
          });
        } else {
          work = Promise.reject(new Error(`no such function: ${name}`));
        }
        const result = await Promise.race([
          work,
          this.deps.sleep(BACKEND_FUNCTION_DEADLINE_MS).then(() => timedOut as unknown),
        ]);
        if (result === timedOut) {
          void work.catch(() => {});
          throw new Error(`took longer than ${BACKEND_FUNCTION_DEADLINE_MS}ms`);
        }
        const json = JSON.stringify(result ?? { status: "done" });
        output =
          json.length > FUNCTION_OUTPUT_MAX_CHARS
            ? JSON.stringify({ truncated: json.slice(0, FUNCTION_OUTPUT_MAX_CHARS) })
            : json;
      } catch (error) {
        /* The backend HEARS the failure and can say so. */
        output = JSON.stringify({ error: String(error).slice(0, 1_000) });
      }
      dial.openBackendCalls = Math.max(0, dial.openBackendCalls - 1);
      /* The fence every provider-side completion wears: a re-dialed call is
       * a NEW session that never issued this call_id. */
      if (this.#dial !== dial) return;
      /*
       * THE REST OF THE REQUEST. Held while the person is still talking (no
       * hold for a person who has finished), then whatever they said since
       * the delegation was raised goes to the backend as a developer message
       * ahead of this result — the Responses delegation accepts the item
       * (measured 2026-09-11) and the backend acts on it instead of asking.
       */
      const heldFromFacetMs = this.deps.nowAtFacetMs();
      while (
        holdForTheRestOfTheRequest &&
        dial.lastUserFragmentAtFacetMs !== null &&
        this.deps.nowAtFacetMs() - dial.lastUserFragmentAtFacetMs < USER_STILL_TALKING_MS &&
        this.deps.nowAtFacetMs() - heldFromFacetMs < FORWARD_HOLD_MAX_MS
      ) {
        await this.deps.sleep(250);
        if (this.#dial !== dial) return;
      }
      const saidSince = holdForTheRestOfTheRequest
        ? dial.userTranscript.slice(dial.forwardedUserChars).replace(/\s+/g, " ").trim()
        : "";
      if (holdForTheRestOfTheRequest) dial.forwardedUserChars = dial.userTranscript.length;
      if (saidSince !== "") {
        this.#sendControl(
          dial,
          {
            type: "response.item.create",
            event_id: `heard_${callId}`,
            item: {
              type: "message",
              role: "developer",
              content: [
                {
                  type: "input_text",
                  text: `The person has said more since this delegation was raised: "${saidSince}"`,
                },
              ],
            },
          },
          append,
        );
      }
      /*
       * THE VOICE HEARS THE BACKEND WORK, one line per step. The backend's
       * response reaches the voice only when it completes; until then the
       * voice knows nothing, and asked "how is it going?" it makes something
       * up (measured 2026-09-11: "started scanning, no summaries yet" while
       * the backend had run eight scripts). With these notes it answered
       * with the actual steps. General context, not a delegation's own
       * (the Responses delegation refuses its id here).
       */
      dial.backendSteps += 1;
      const nowForNoteMs = this.deps.nowAtFacetMs();
      if (
        dial.lastProgressNoteAtFacetMs === null ||
        nowForNoteMs - dial.lastProgressNoteAtFacetMs >= PROGRESS_NOTE_MIN_GAP_MS
      ) {
        dial.lastProgressNoteAtFacetMs = nowForNoteMs;
        this.#sendControl(
          dial,
          {
            type: "session.thinking.append",
            event_id: `progress_${callId}`,
            delegation_id: null,
            /* Status only, never the output: a docs snippet in a note came
             * back out of the voice as a question to the person. */
            content:
              `Backend progress note, for your own awareness only — do not read it out. ` +
              `Step ${String(dial.backendSteps)}: ran ${name}` +
              `(${rawArguments.replace(/\s+/g, " ").slice(0, 160)}) → ` +
              `${output.startsWith('{"error"') ? "error" : "ok"}`,
          },
          append,
        );
      }
      this.#sendControl(
        dial,
        {
          type: "response.item.create",
          event_id: `result_${callId}`,
          item: { type: "function_call_output", call_id: callId, output },
        },
        append,
      );
      this.#sendControl(dial, { type: "response.create", event_id: `continue_${callId}` }, append);
    });
  }

  /**
   * Send one client command AND record it in the mirror as
   * `client.<type>` — the mirror is the wire's flight recorder, and a recorder
   * that hears only one direction cannot explain a silence.
   */
  #sendControl(
    dial: Dial,
    message: Record<string, unknown>,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    if (dial.socket === null) return;
    dial.socket.send(JSON.stringify(message));
    const { item, ...rest } = message;
    this.#appendMirror(
      {
        ...rest,
        type: `client.${String(message.type)}`,
        ...(item === undefined ? {} : { itemSummary: JSON.stringify(item).slice(0, 300) }),
        conversationId: dial.conversationId,
        receivedAtFacetMs: this.deps.nowAtFacetMs(),
      },
      append,
    );
  }

  /**
   * What a face-rendering board's 10 Hz poll reads. A POLL, NOT A LIVESTATE
   * SUBSCRIPTION, and not by preference: a userspace facet's liveState node
   * serves the runner's committed FOLD, and the override that could project
   * a runtime bag is a hook `StreamProcessorFacet.createHost` never exposes.
   */
  override async getRuntimeState() {
    return {
      runtime: {
        buildCacheKey: this.deps.buildCacheKey,
        face: this.#dial?.face?.read() ?? null,
        now: this.deps.nowAtFacetMs(),
      },
    };
  }

  /* ------------------------------------------------------------ the floor */

  /**
   * THE BUTTON TOOK THE FLOOR: kill the answer everywhere, now.
   *
   * GPT-Live will yield on its own the moment it hears the person — 71 ms,
   * measured — and it remembers what it said, so there is no cancel to send
   * and no memory to repair. What the press owes is the DEVICE: it holds a
   * beat of the answer, and "interrupted" must not sound like a beat more of
   * it. The queue goes, the device is cleared, the deltas that arrive until
   * the model yields are dropped, and taking the floor back un-decides a
   * pending hang-up ("the user talked past the goodbye").
   */
  #bargeAnswer(
    dial: Dial,
    decidedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    dial.hangUpAfterAnswerDrains = null;
    dial.hangUpArmedAtFacetMs = 0;
    if (dial.answer.phase !== "speaking" && dial.speakerQueue.length === 0) return;
    dial.face?.barge(decidedAtFacetMs);
    if (dial.turns.assistant !== null) dial.turns.assistant.interrupted = true;
    this.#dropAnswerInFlight(dial, decidedAtFacetMs, append);
    dial.answer.phase = "settled";
    dial.answer.endsWhenQueueDrains = false;
    dial.suppressSpeechUntilSilence = true;
  }

  /**
   * Throw away the answer being spoken, here and on the device, right now.
   * Every frame minted so far belongs to an answer nobody will hear. AND THE
   * NEXT REAL FRAME SAYS IT AGAIN: the clear is one empty frame in a stream of frames
   * that documents its own drops; the first frame of the replacing answer
   * carries the clear too, so it cannot be lost without losing the
   * replacement itself.
   */
  #dropAnswerInFlight(
    dial: Dial,
    decidedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    dial.speakerQueue = [];
    dial.deviceBufferEmptyAtFacetMs = 0;
    this.#clearDeviceSpeaker(dial, decidedAtFacetMs, append);
    dial.clearSpeakerBufferBeforeNextFrame = true;
  }

  /**
   * Tell the device to empty its speaker, and touch nothing local.
   *
   * THE CLEAR RIDES ON A FRAME, and an empty one is still a frame. The device
   * is holding dead audio and has to be told NOW; the instruction goes out as
   * a frame of its own carrying the next sequence number, so the device
   * orders it after everything it cancels. A watermark makes a repeated
   * press free.
   */
  #clearDeviceSpeaker(
    dial: Dial,
    decidedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    const clearedThroughDeviceSpeakerFrameSeq = dial.lastDeviceSpeakerFrameSeq;
    if (clearedThroughDeviceSpeakerFrameSeq <= dial.clearedThroughDeviceSpeakerFrameSeq) return;
    const clearFrameSeq = ++dial.lastDeviceSpeakerFrameSeq;
    dial.clearedThroughDeviceSpeakerFrameSeq = clearFrameSeq;
    this.runInBackground(() =>
      append({
        type: "events.iterate.com/voice-agent/spk-frame",
        payload: {
          conversationId: dial.conversationId,
          deviceSpeakerFrameSeq: clearFrameSeq,
          pcm: "",
          clearSpeakerBufferBeforeFrame: true,
          sentAtFacetMs: decidedAtFacetMs,
        },
      }),
    );
  }

  /**
   * Hand over one frame of audio per frame of audio's worth of time.
   *
   * THAT IS THE WHOLE RULE, and it is the only thing keeping the device's
   * speaker buffer from overflowing: a sender that runs at play rate can
   * never make the backlog grow. `deviceBufferEmptyAtFacetMs` is a schedule
   * this processor invented and controls — a DEADLINE rather than a sleep
   * between sends, because the append itself takes time. With GPT-Live the
   * arrival IS play rate, so the loop mostly finds one frame and sends it.
   *
   * ONE LOOP, THREE JOBS, AND IT EXITS ONLY WHEN NONE REMAINS: drain, then
   * the end marker, then a pending hang-up — looping back after every await
   * so nothing lands during an await that the next iteration does not see.
   */
  #sendSpeakerAudio(
    dial: Dial,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    if (dial.sending) return;
    dial.sending = true;
    runInBackground(async () => {
      try {
        for (;;) {
          /* The dial this pacer belongs to is gone — a hang-up or a re-dial
           * owns the wire now. */
          if (this.#dial !== dial) return;
          if (dial.speakerQueue.length > 0) {
            const nowAtFacetMs = this.deps.nowAtFacetMs();
            /* A DEADLINE IN THE PAST MEANS THE DEVICE RAN DRY WHILE WE WERE
             * AWAY, and the backlog cannot be less than nothing. */
            if (dial.deviceBufferEmptyAtFacetMs < nowAtFacetMs) {
              dial.deviceBufferEmptyAtFacetMs = nowAtFacetMs;
            }
            /* PEEK, never shift: a clear arriving during the sleep below has
             * to be able to filter this frame out of the queue. */
            const frame = dial.speakerQueue[0]!;
            const frameBytes = base64ByteLength(frame);
            /* THE WHOLE SAFETY PROOF, IN ONE INEQUALITY. */
            const overflowBytes =
              (dial.deviceBufferEmptyAtFacetMs - nowAtFacetMs) * PCM16_BYTES_PER_MS +
              frameBytes -
              MAX_DEVICE_SPEAKER_BACKLOG_BYTES;
            if (overflowBytes > 0) {
              await this.deps.sleep(Math.ceil(overflowBytes / PCM16_BYTES_PER_MS));
              continue;
            }
            dial.speakerQueue.shift();
            dial.deviceBufferEmptyAtFacetMs += frameBytes / PCM16_BYTES_PER_MS;
            dial.answer.sentMs += frameBytes / PCM16_BYTES_PER_MS;
            /* THE FACE FOLDS AT SEND TIME, on the frame the device is about
             * to play. The decode is the one the speaker path pays for a face, and
             * only when a face is rendering. */
            if (dial.face !== null) {
              dial.face.audio(base64ToBytes(frame), nowAtFacetMs);
            }
            const clearFirst = dial.clearSpeakerBufferBeforeNextFrame;
            dial.clearSpeakerBufferBeforeNextFrame = false;
            await append({
              type: "events.iterate.com/voice-agent/spk-frame",
              payload: {
                conversationId: dial.conversationId,
                deviceSpeakerFrameSeq: ++dial.lastDeviceSpeakerFrameSeq,
                pcm: frame,
                ...(clearFirst && { clearSpeakerBufferBeforeFrame: true }),
                sentAtFacetMs: nowAtFacetMs,
              },
            });
            continue;
          }
          /*
           * THE QUEUE IS EMPTY, so if the answer has ended, the device now
           * holds the whole of it and can be told so. Behind the drain rather
           * than beside it: the marker cannot overtake audio it is about.
           */
          if (dial.answer.endsWhenQueueDrains) {
            dial.answer.endsWhenQueueDrains = false;
            /* The mouth closes WITH the marker, not at the provider's
             * silence: SIL at ingest shut it before the speech finished. */
            dial.face?.answerAudioDone(this.deps.nowAtFacetMs());
            dial.answerEndedAtFacetMs = this.deps.nowAtFacetMs();
            dial.lastDeviceSpeakerFrameSeq += 1;
            const clearFirst = dial.clearSpeakerBufferBeforeNextFrame;
            dial.clearSpeakerBufferBeforeNextFrame = false;
            await append({
              type: "events.iterate.com/voice-agent/spk-frame",
              payload: {
                conversationId: dial.conversationId,
                deviceSpeakerFrameSeq: dial.lastDeviceSpeakerFrameSeq,
                pcm: "",
                ...(clearFirst && { clearSpeakerBufferBeforeFrame: true }),
                lastFrameOfAnswer: true,
                sentAtFacetMs: this.deps.nowAtFacetMs(),
              },
            });
            continue;
          }
          /* THE BACKEND HUNG UP, and the drain point is where that settles:
           * the device holds the whole goodbye; the pacer's own deadline
           * says when it finishes PLAYING. Sleep that off, re-check (a press
           * during playout un-decides it), then one atomic append. Not
           * settleable while the voice is still speaking, and not before the
           * goodbye has been spoken at all — an answer must END after the
           * hang-up was armed, or the grace must run out. */
          if (
            dial.hangUpAfterAnswerDrains !== null &&
            dial.answer.phase !== "speaking" &&
            ((dial.answerEndedAtFacetMs > 0 &&
              dial.answerEndedAtFacetMs >= dial.hangUpArmedAtFacetMs) ||
              this.deps.nowAtFacetMs() - dial.hangUpArmedAtFacetMs >= HANG_UP_GOODBYE_GRACE_MS)
          ) {
            await this.deps.sleep(
              Math.max(0, dial.deviceBufferEmptyAtFacetMs - this.deps.nowAtFacetMs()),
            );
            if (this.#dial !== dial) return;
            const reason = dial.hangUpAfterAnswerDrains;
            if (reason !== null && dial.speakerQueue.length === 0) {
              dial.hangUpAfterAnswerDrains = null;
              await this.#requestEnd(dial.conversationId, "hang-up", reason, append);
            }
            continue;
          }
          return;
        }
      } finally {
        dial.sending = false;
      }
    });
  }

  /**
   * Let the dial and everything hanging off it go. Safe to call twice. The
   * provider is asked to close first — `session.close` is what makes it
   * finalize usage — and the socket is closed behind it without waiting: a
   * hang-up must not depend on the far end's manners.
   */
  #hangUp(): void {
    this.#micQueue = [];
    const dial = this.#dial;
    this.#dial = null;
    try {
      if (dial?.socket !== null && dial?.ready) {
        dial.socket.send(JSON.stringify({ type: "session.close" }));
      }
    } catch {
      /* Already gone. */
    }
    try {
      dial?.socket?.close();
    } catch {
      /* Already gone. */
    }
  }
}

/* ========================================================================== */
/* FACET                                                                      */
/* ========================================================================== */

/**
 * The credential follows the HOST, never a flag: a test hook pointing at a
 * fake gets no secret at all. THE ONE COPY of the host→secret rule — the
 * dial spends it and setup's gate demands it, so the two cannot disagree.
 */
function secretForHost(hostname: string): string | null {
  if (hostname === "api.openai.com") return OPENAI_SECRET;
  return null;
}

/**
 * Open the provider's WebSocket. No query parameters — the model rides
 * `session.start` — and the bearer is the platform's `getSecret` grammar,
 * substituted at egress so the key never enters this isolate.
 */
export async function dialProviderSocket(baseUrl: string | null): Promise<WebSocket | null> {
  const target = new URL(baseUrl ?? LIVE.url);
  const headers: Record<string, string> = { Upgrade: "websocket" };
  const secret = secretForHost(target.hostname);
  if (secret !== null) headers.Authorization = `Bearer getSecret("${secret}")`;
  const response = await fetch(target.toString(), { headers });
  /* `?? null` rather than `=== null`: a runtime with no WebSockets in it has no
   * such property at all, and `undefined === null` is false — which turned a
   * provider refusal into a TypeError on the next line. */
  const socket = response.webSocket ?? null;
  if (socket === null) return null;
  socket.binaryType = "arraybuffer"; // before accept(): the current default is Blob
  socket.accept();
  return socket;
}

/* ========================================================================== */
/* SETUP                                                                      */
/* ========================================================================== */

/** A stable short digest, so re-running setup with identical input appends nothing. */
function contentHash(value: unknown): string {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index++) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

/** Release an RPC wrapper whose contents have already been read. */
function disposeRpcStub(value: unknown, label: string): void {
  try {
    disposeIgnoredRpcResult(value);
  } catch (error) {
    console.error("voice-agent RPC stub disposal failed", { error, label });
  }
}

/** How long setup's fold-through barrier waits. A cold facet build is most of it. */
const WARMUP_DEADLINE_MS = 90_000;

/** What setup needs to know to put this agent on a stream. */
export default class VoiceAgentEntrypoint extends IterateWorkerEntrypoint implements VoiceAgentRpc {
  /**
   * Prove this guest is built, running, and can reach its own project. A
   * dynamic worker is built lazily on the first call into it; a call whose
   * only job is to be the first one lets a caller pay for the build
   * deliberately.
   */
  async health(): Promise<VoiceAgentHealth> {
    const project = await this.itx;
    return {
      ok: true,
      projectId: await project.projectId,
      buildCacheKey: String(
        (this.env as Record<string, unknown>).ITERATE_WORKER_VERSION ?? "unknown",
      ),
    };
  }

  async setupVoiceAgent(options: SetupVoiceAgentOptions = {}): Promise<SetupVoiceAgentResult> {
    const streamPath = options.streamPath ?? `/agents/voice/${crypto.randomUUID()}`;
    if (!streamPath.startsWith("/")) {
      throw new Error(
        `voice-agent streamPath must be absolute; received ${JSON.stringify(streamPath)}`,
      );
    }

    const project = await this.itx;
    /* Demand exactly the secret the dial will spend — the one host→credential
     * rule in secretForHost. A providerBaseUrl hook resolves to no secret and
     * gets no gate. */
    const dialTarget = new URL(options.providerBaseUrl ?? LIVE.url);
    const secretPath = secretForHost(dialTarget.hostname);
    if (secretPath !== null) {
      const providerSecret = project.secrets.get(secretPath);
      let secretReady = false;
      try {
        const description = await providerSecret.__describe();
        try {
          secretReady = description.created === true && description.hasMaterial === true;
        } finally {
          disposeRpcStub(description, "setup secret description result");
        }
      } finally {
        disposeRpcStub(providerSecret, "setup secret");
      }
      if (!secretReady) {
        throw new Error(
          `voice-agent setup requires secret "${secretPath}" with material. Create it with ` +
            `await itx.secrets.get("${secretPath}").create({ egress: { urls: ["${dialTarget.origin}"] }, ` +
            `material: "<API key>" }); then rerun. This agent never creates or copies credentials.`,
        );
      }
    }

    const stream = project.streams.get(streamPath);
    try {
      /*
       * BIRTH AND CONFIGURATION, SPLIT. `created` is existence only, under a
       * key with nothing but the stream path in it. The configuration is an
       * ordinary event, keyed per SETUP RUN so every run applies.
       */
      const { streamPath: _streamPath, reinstall: _reinstall, ...configPayload } = options;
      const setupId = crypto.randomUUID();
      const subscriptionPayload = {
        name: VoiceAgentContract.slug,
        description: "Wake the voice-agent facet in this stream's own Durable Object.",
        /* DERIVED from the contract, never hand-written: delivery is this
         * filter INTERSECTED with `consumes`. */
        filter: { eventTypes: [...VoiceAgentContract.consumes] },
        receiver: {
          action: "facet-processor",
          source: { kind: "userspace", worker: voiceAgentFacetRef(streamPath) },
        },
      };
      const subscriptionKeyPrefix = `voice-agent/subscription:${streamPath}`;
      const committed = await stream.append(
        {
          type: "events.iterate.com/voice-agent/created",
          idempotencyKey: `voice-agent/created:${streamPath}`,
          payload: {},
        },
        {
          type: "events.iterate.com/voice-agent/configured",
          idempotencyKey: `voice-agent/configured:${streamPath}:setup:${setupId}`,
          payload: configPayload,
        },
        {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: options.reinstall
            ? `${subscriptionKeyPrefix}:reinstall:${crypto.randomUUID()}`
            : `${subscriptionKeyPrefix}:${contentHash(subscriptionPayload)}`,
          payload: subscriptionPayload,
        },
      );
      /* The batch's HIGHEST offset is the barrier target. */
      let setupBatchMaxOffset = 0;
      try {
        for (const event of committed) {
          setupBatchMaxOffset = Math.max(setupBatchMaxOffset, event.offset);
        }
      } finally {
        disposeRpcStub(committed, "setup stream append result");
      }

      /*
       * THE PLATFORM'S OWN BARRIER: `waitUntilProcessed` resolves once the
       * facet subscription has durably folded through the batch above —
       * forcing the cold build and proving the fold has REACHED the birth
       * certificate. ENFORCED by the throw inside the barrier's timeout.
       */
      const warmStartedAt = Date.now();
      const subscription = stream.subscriptions.get(VoiceAgentContract.slug);
      try {
        await subscription.waitUntilProcessed({
          offset: setupBatchMaxOffset,
          timeoutMs: WARMUP_DEADLINE_MS,
        });
      } finally {
        disposeRpcStub(subscription, "setup subscription");
      }
      return { streamPath, warmMs: Date.now() - warmStartedAt };
    } finally {
      disposeRpcStub(stream, "setup stream");
    }
  }

  /** Take the subscription off a stream, so the facet stops waking. */
  async removeVoiceAgent(options: { streamPath: string }): Promise<{ streamPath: string }> {
    const project = await this.itx;
    const stream = project.streams.get(options.streamPath);
    try {
      const removed = await stream.append({
        type: "events.iterate.com/stream/subscription-removed",
        idempotencyKey: `voice-agent/subscription-removed:${options.streamPath}:${crypto.randomUUID()}`,
        payload: { name: VoiceAgentContract.slug },
      });
      disposeRpcStub(removed, "remove append result");
      return { streamPath: options.streamPath };
    } finally {
      disposeRpcStub(stream, "remove stream");
    }
  }
}

export class VoiceAgentFacet extends StreamProcessorFacet {
  protected readonly recovery = true;
  protected createProcessor(deps: ProcessorHostDeps) {
    return new VoiceAgentProcessor({
      ...deps,
      nowAtFacetMs: () => Date.now(),
      /* The loader bakes the build's content-addressed key into the env
       * (ITERATE_WORKER_VERSION); surfacing it is the only way to tell which
       * build a LIVE facet is running. */
      buildCacheKey: String(
        (this.env as Record<string, unknown>).ITERATE_WORKER_VERSION ?? "unknown",
      ),
      /* Safe as a bare setTimeout BECAUSE of where it is awaited: every wait
       * here happens inside a `runInBackground` closure the keepalive holds. */
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      dialProvider: (baseUrl) => dialProviderSocket(baseUrl),
      withProject: async <T>(fn: (project: unknown) => Promise<T>): Promise<T> => {
        const project = await this.env.ITX.get();
        try {
          return await fn(project);
        } finally {
          try {
            (project as Partial<Disposable>)[Symbol.dispose]?.();
          } catch {
            /* Already gone. */
          }
        }
      },
    });
  }
}
