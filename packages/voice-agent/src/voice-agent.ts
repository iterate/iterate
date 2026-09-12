/** GPT-Live relay and durable call fold for one voice stream. */
import {
  IterateWorkerEntrypoint,
  StreamProcessorFacet,
  type AgentEventInput,
  type ProcessorHostDeps,
  type Project,
} from "iterate/sdk";
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

/** Fixed GPT-Live session configuration. */
const LIVE = {
  url: "https://api.openai.com/v1/live/sessions",
  model: "gpt-live-1",
  voice: "marin",
  rate: 16_000,
} as const;

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
 * The provider hears silence when the device sends nothing. GPT-Live's
 * session timeline is driven by INPUT audio ("keep input audio running,
 * including silence" — its docs), and a client that goes quiet between
 * utterances (a released button, the C driver's converse mode) starved it:
 * measured on preview-7 (2026-09-11) the answer to "count to sixty" died
 * after "Okay. one two" when the client sent nothing, and ran to sixty when
 * it sent silence frames. So the facet fills the gaps itself: whenever no
 * device audio has been forwarded for this long, one frame of digital
 * silence of this length goes to the provider instead. A device that streams
 * continuously never triggers it.
 */
export const SILENCE_FILL_MS = 100;
/**
 * A delayed Durable Object must not burst an unbounded amount of synthetic
 * input ahead of a person who has started speaking again. One second is long
 * enough to recover ordinary scheduling jitter. A larger discontinuity leaves
 * the provider's input timeline untrustworthy, so the call ends with a
 * classified reason rather than dropping that debt without an explanation.
 */
const MAX_SILENCE_FILL_CATCH_UP_MS = 1_000;
/**
 * How often a background loop waiting for work re-checks that its dial is
 * still the live one. See #startSpeakerSender.
 */
const BACKGROUND_LOOP_TICK_MS = 1_000;
const SILENCE_FILL_FRAME_B64 = bytesToBase64(new Uint8Array(SILENCE_FILL_MS * 32));

/**
 * The idle stamp advances in steps of this, not per frame. Folding every mic
 * frame's commit stamp made EVERY delivery batch dirty the reduced state; the
 * deadline is sixty seconds, so knowing the device's last input to five is
 * every bit as good, and the fold is a no-op for ~95% of mic batches.
 */
const IDLE_STAMP_STEP_MS = 5_000;

/** How often the idle countdown looks at the facet clock. */
const IDLE_TICK_MS = 5_000;

/** Socket creation and `session.started` must both finish within this bound. */
const OPENING_DEADLINE_MS = 15_000;

/**
 * How long a decided hang-up waits for the goodbye. The Agent calls
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
 * Once the goodbye's end marker has gone out, how long the device is given
 * to play what it still holds before the call is ended. The relay hands
 * frames over as they arrive, so the device holds at most its own small
 * playout buffer (the firmware prefills 150 ms) plus one frame in flight.
 */
const GOODBYE_PLAYOUT_ALLOWANCE_MS = 500;
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

type AgentTranscriptContext = { role: "user" | "developer"; content: string };

function agentTranscriptContext(
  speaker: "user" | "assistant",
  text: string,
): AgentTranscriptContext {
  return speaker === "user"
    ? { role: "user", content: text }
    : { role: "developer", content: `Voice agent (spoken transcript): ${text}` };
}

/** Fold one finished turn onto the recap, applying both bounds. */
function foldTranscriptTurn(transcript: TranscriptTurn[], turn: TranscriptTurn): TranscriptTurn[] {
  const text =
    turn.text.length > TRANSCRIPT_TURN_MAX_CHARS
      ? `${turn.text.slice(0, TRANSCRIPT_TURN_MAX_CHARS)}…`
      : turn.text;
  return [...transcript, { role: turn.role, text }].slice(-TRANSCRIPT_MAX_TURNS);
}

/** Each Live context append allows 500 tokens. UTF-8 bytes are a conservative
 * upper bound, independent of language/tokenizer; split at spaces where possible. */
function* commentaryChunks(text: string): Generator<string> {
  const encoder = new TextEncoder();
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (bytes + size > 500) {
      const space = chunk.lastIndexOf(" ");
      const boundary = space > 0 ? space + 1 : chunk.length;
      yield chunk.slice(0, boundary);
      chunk = chunk.slice(boundary);
      bytes = encoder.encode(chunk).length;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) yield chunk;
}

/* ========================================================================== */
/* BACKEND                                                                     */
/* ========================================================================== */

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
  "- This project’s standard Agent processor: it can read and change the",
  "  project, look things up, run scripts, and end this call after saying goodbye.",
  "Ending the call:",
  "- Always request a NEW client delegation when the user asks to end or hang up,",
  "  or when the conversation is clearly over, even after earlier backend work completed.",
  "- Only the backend closes the call. Saying goodbye does not close it: delegate",
  "  BEFORE a goodbye, then wait for the backend's goodbye result.",
  "- Do not stop conversing merely because you acknowledged ending. If the user still",
  "  asks, respond and delegate again.",
  "Delegate to the backend when:",
  "- The person asks for information, reasoning, a lookup, a change, device control, or",
  "  ending the call. Delegate even trivial requests. When uncertain, delegate.",
  "- The person repeats or corrects a request. Every newly spoken request needs a NEW",
  "  client delegation, even if an identical request appears in prior conversation history.",
  "Do not delegate to the backend when:",
  "- It is social conversation, a brief clarifying question, or repeating a verified result.",
  "Request client delegation IMMEDIATELY, BEFORE acknowledging an action or saying",
  "you will check. Saying 'I'll check' does not start backend work. Only after delegating",
  "may you say you've handed it over. Past acknowledgments in conversation history do not",
  "mean a request in this new call has been delegated. Keep conversing while the Agent works.",
  "Do not guess results or invent progress. Say a thing is",
  "done only when the backend has reported it done for THAT request. Relay backend results",
  "faithfully, read one out in full when the person wants the details, and correct yourself",
  "plainly if one contradicts something you said. If the backend reports a failure, SAY SO",
  "— never invent an explanation for a delay or a result you have not seen.",
].join("\n");

function agentVoiceProtocol(streamPath: string): string {
  return [
    "You are the project's ordinary Agent working with GPT-Live client delegation on this stream.",
    "Voice delegation metadata is platform context, not user speech. Preserve each activation and delegationId with the work it describes; several delegations may be outstanding.",
    "Voice transcripts can be incomplete or corrected; entries keyed `voice-agent/transcript:` record either a human or GPT-Live speaking, and GPT-Live speech (labelled `Voice agent (spoken transcript):` in new entries) is never your output, a task completion, or evidence an action happened. Use later context before acting, and let ordinary Agent work continue after a voice call ends.",
    "To guide GPT-Live, append one of these plain-string events to this stream:",
    "- events.iterate.com/voice-agent/instructions directs the live model's behaviour.",
    "- events.iterate.com/voice-agent/thinking provides quiet facts or progress that the live model may use without saying immediately.",
    "- events.iterate.com/voice-agent/commentary provides verified information for the live model to paraphrase aloud. Completing a task does not end a call: omit hangUp on ordinary results. Set hangUp: true only when the current user asks to end the call or clearly says goodbye, never merely because backend work finished; its content must be a short goodbye.",
    "Each payload is { activation, delegationId, content }; delegationId may be null for general context. commentary alone does not complete a delegation. Do not derive voice commentary from raw assistant transcript or executable model output.",
    "For example:",
    `await itx.streams.get(${JSON.stringify(streamPath)}).append({`,
    '  type: "events.iterate.com/voice-agent/thinking",',
    '  idempotencyKey: "a-stable-key-for-this-update",',
    '  payload: { activation, delegationId, content: "A verified progress fact." },',
    "});",
    "Keep content within 500 tokens and use a distinct stable idempotency key for each update.",
  ].join("\n");
}

function agentSetupEvents(
  streamPath: string,
  model: string | undefined,
  setupId: string,
): AgentEventInput[] {
  return [
    ...(!model
      ? []
      : [
          {
            type: "events.iterate.com/agent/configured" as const,
            idempotencyKey: `voice-agent/agent-model:${streamPath}:${setupId}`,
            payload: {
              config: { llm: { model: model.includes("/") ? model : `openai/${model}` } },
            },
          },
        ]),
    {
      type: "events.iterate.com/agents/context-added" as const,
      idempotencyKey: `voice-agent/agent-protocol:${streamPath}:${setupId}`,
      payload: {
        role: "system",
        key: "voice-agent/protocol",
        content: agentVoiceProtocol(streamPath),
        llmRequestPolicy: { behaviour: "dont-trigger-request" as const },
      },
    },
  ];
}

/**
 * How much decoded microphone audio may be held while the provider completes
 * its handshake. The wire accepts any even PCM byte length, so a frame count
 * cannot bound memory or stale speech. Twenty-one seconds covers the
 * clients' twenty-second opening capture budget without silently truncating
 * a request.
 *
 * Overflow ends this opening once with a durable reason. Keeping the prefix
 * while silently discarding its ending would tell the model a different
 * request, so the next activation is the only honest recovery.
 */
const MAX_HELD_MIC_BYTES = 16_000 * 2 * 21;

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

/** Backend overrides — see VoiceBackendInput in setup-options.ts. */
const VoiceBackend = z.looseObject({
  model: z.string().optional(),
  instructions: z.string().optional(),
});

/** A client-local call identity; opaque to the backend and durable fold. */
const Activation = z.string().min(1).max(64);

/* Firmware holds at most two terminals while its ordered sender waits for
 * stream capacity. Remember that exact bounded set, so either delayed
 * terminal still fences its own queued microphone audio. */
const RECENT_ENDED_ACTIVATIONS_CAPACITY = 2;

/**
 * Everything that outlives the Durable Object holding the socket.
 *
 * Note what is NOT here: no queues, no byte counts, no "is speaking" flag.
 * Reduced state that depends on a buffer no restart can replay is a lie.
 */
const VoiceState = z.object({
  /** The voice's persona. Empty means the delegation policy alone. */
  instructions: z.string().default(""),
  /**
   * Classify the answer's audio into mouth shapes and publish the newest one
   * in the runtime bag, where a face-rendering board's 10 Hz poll reads it.
   * Certificate data because it is a fact about the CLIENT.
   */
  visemes: z.boolean().default(false),
  /** Backend overrides; an empty object is the package's defaults. */
  backend: VoiceBackend.default({}),
  /**
   * The rolling recap: the newest finished turns, in words, both sides.
   * Folded from the durable transcript events and seeded as history into
   * every fresh provider session, so a re-dial resumes the conversation.
   */
  transcript: z
    .array(z.strictObject({ role: z.enum(["listener", "assistant"]), text: z.string() }))
    .default([]),
  /** Legacy single tombstone, read while old durable state is upgraded. */
  lastEndedActivation: Activation.nullable().default(null),
  /** Recent client terminals, newest first; see RECENT_ENDED_ACTIVATIONS_CAPACITY. */
  recentEndedActivations: z.array(Activation).max(RECENT_ENDED_ACTIVATIONS_CAPACITY).default([]),
  call: z
    .object({
      conversationId: z.string(),
      activation: Activation,
      /**
       * When the Stream DO committed the device's most recent input — a mic
       * frame or a button edge. THE DEVICE'S INPUT, not "the last thing
       * anybody said": the agent's own speech leaves no durable event.
       */
      lastDeviceInputAtStreamMs: z.number(),
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
  version: "24.0.0",
  description:
    "Runs a GPT-Live voice call in the stream's own Durable Object, relaying audio both ways as it arrives.",
  stateSchema: VoiceState,
  events: {
    "events.iterate.com/voice-agent/created": {
      description:
        "The voice agent exists on this stream. Existence and nothing else — appended once, " +
        "under a stable key; configuration rides `configured`.",
      payloadSchema: z.strictObject({}),
    },
    "events.iterate.com/voice-agent/configured": {
      description: "The agent configuration. An absent field resets to its default.",
      /* v23 accepted a tools array. Ignore that historic field while replaying
       * an existing stream; v24 neither accepts it as setup nor emits it. */
      payloadSchema: z.looseObject({
        instructions: z.string().optional(),
        visemes: z.boolean().optional(),
        backend: VoiceBackend.optional(),
      }),
    },
    /*
     * THE DEVICE'S HALF is one verb and a heartbeat: here is audio, I am
     * still here. Whether a call exists, what it is called and when it ends
     * are the server's. A button, where a client has one, only unmutes its
     * microphone while held; nothing about it travels.
     */
    "events.iterate.com/voice-agent/keepalive": {
      description:
        "The client's call UI is alive, said every ~20s: feeds the idle deadline so a caller " +
        "who waits quietly is not reaped at 60s of mic silence.",
      ...EPH,
      payloadSchema: z.strictObject({}),
    },
    "events.iterate.com/voice-agent/mic-frame": {
      description:
        "One capture chunk. A client writes mic and terminal events from one ordered local sender; " +
        "the first frame on a quiet stream opens its activation.",
      ...EPH,
      payloadSchema: z.looseObject({
        activation: Activation,
        /** 16 kHz mono PCM16, base64. The only encoding these frames carry. */
        pcm: z.string(),
      }),
    },
    "events.iterate.com/voice-agent/call-started": {
      description:
        "The server opened a client activation and assigned its authoritative conversation id.",
      payloadSchema: z.looseObject({ activation: Activation, conversationId: z.string() }),
    },
    "events.iterate.com/voice-agent/conversation-accepted": {
      description: "The provider started the session; the call is live.",
      payloadSchema: z.looseObject({
        activation: Activation,
        conversationId: z.string(),
        /** Facet clock: dial to usable, the number a cold call is judged on. */
        handshakeTookMs: z.number(),
        /** Capture held during the handshake and released in one go. */
        heldMicFrames: z.number(),
      }),
    },
    "events.iterate.com/voice-agent/conversation-ended": {
      description:
        "The local activation is over. A client may append this before the server assigns a conversation id.",
      payloadSchema: z.looseObject({ activation: Activation, reason: z.string() }),
    },
    "events.iterate.com/voice-agent/provider-error": {
      description: "The provider reported an error, verbatim.",
      payloadSchema: z.looseObject({ conversationId: z.string(), message: z.string() }),
    },
    "events.iterate.com/voice-agent/provider-disconnected": {
      description: "The provider's session or socket closed under a live call.",
      payloadSchema: z.looseObject({ conversationId: z.string(), reason: z.string() }),
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
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        text: z.string(),
        key: z.string().optional(),
      }),
    },
    "events.iterate.com/voice-agent/answer-transcript": {
      description:
        "The provider's own transcript of one finished spoken answer — what was said, not " +
        "necessarily what was heard: the listener may have talked over it.",
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        text: z.string(),
        key: z.string().optional(),
      }),
    },
    "events.iterate.com/voice-agent/instructions": {
      description: "A standard Agent instruction for the live model's behaviour.",
      payloadSchema: z.object({
        activation: Activation,
        delegationId: z.string().nullable(),
        content: z.string().min(1).max(8_000),
      }),
    },
    "events.iterate.com/voice-agent/thinking": {
      description: "A standard Agent factual update for the live model to use quietly.",
      payloadSchema: z.object({
        activation: Activation,
        delegationId: z.string().nullable(),
        content: z.string().min(1).max(8_000),
      }),
    },
    "events.iterate.com/voice-agent/commentary": {
      description: "A standard Agent fact for the live model to paraphrase aloud.",
      payloadSchema: z.object({
        activation: Activation,
        delegationId: z.string().nullable(),
        content: z.string().min(1).max(8_000),
        hangUp: z.boolean().optional(),
      }),
    },
    "events.iterate.com/voice-agent/session-configured": {
      description:
        "The whole briefing one provider session was started with — recorded so the stream shows how the voice was initialized.",
      /* Loose for v23 rows that included backend fields. */
      payloadSchema: z.looseObject({
        activation: Activation,
        conversationId: z.string(),
        provider: z.string(),
        instructions: z.string(),
        delegation: z.literal("client").optional(),
      }),
    },

    /*
     * THE SPEAKER FRAMES. Two events, and between them the device's entire buffer
     * policy: play frames in sequence order, and throw away anything at or
     * below a watermark.
     */
    "events.iterate.com/voice-agent/spk-frame": {
      description:
        "One chunk of the answer, forwarded as it arrived, numbered within the conversation.",
      ...EPH,
      payloadSchema: z.looseObject({
        activation: Activation,
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
  },
  consumes: [
    "events.iterate.com/voice-agent/created",
    "events.iterate.com/voice-agent/configured",
    "events.iterate.com/voice-agent/instructions",
    "events.iterate.com/voice-agent/thinking",
    "events.iterate.com/voice-agent/commentary",
    "events.iterate.com/voice-agent/call-started",
    "events.iterate.com/voice-agent/conversation-ended",
    /* Consumed so the fold sees its own appends and the recap survives an
     * eviction — processEvent has no arm for them on purpose. */
    "events.iterate.com/voice-agent/utterance-transcript",
    "events.iterate.com/voice-agent/answer-transcript",
    /* The live half. Naming them is the whole opt-in — `"*"` never matches an
     * ephemeral event, so nobody gets this firehose by accident. */
    "events.iterate.com/voice-agent/mic-frame",
    /* The client's "still here" heartbeat — consumed only for the idle
     * stamp; processEvent has no arm for it. */
    "events.iterate.com/voice-agent/keepalive",
  ],
  emits: [
    "events.iterate.com/voice-agent/call-started",
    "events.iterate.com/voice-agent/conversation-accepted",
    "events.iterate.com/voice-agent/conversation-ended",
    "events.iterate.com/voice-agent/provider-error",
    "events.iterate.com/voice-agent/provider-disconnected",
    "events.iterate.com/voice-agent/utterance-transcript",
    "events.iterate.com/voice-agent/answer-transcript",
    "events.iterate.com/voice-agent/session-configured",
    "events.iterate.com/voice-agent/spk-frame",
  ],
});
export type VoiceAgentContract = typeof VoiceAgentContract;

type VoiceState = z.infer<typeof VoiceState>;

function recentEndedActivations(state: VoiceState): string[] {
  if (
    !state.lastEndedActivation ||
    state.recentEndedActivations.includes(state.lastEndedActivation)
  ) {
    return state.recentEndedActivations;
  }
  return [state.lastEndedActivation, ...state.recentEndedActivations];
}

function rememberEndedActivation(state: VoiceState, activation: string): string[] {
  const recent = recentEndedActivations(state);
  if (recent.includes(activation)) return recent;
  return [activation, ...recent].slice(0, RECENT_ENDED_ACTIVATIONS_CAPACITY);
}

/**
 * Everything whose lifetime is ONE ANSWER — one run of speech on the
 * provider's continuous output stream. REPLACED WHOLESALE at the onset of
 * speech, instead of hand-reset field by field: an object that is swapped
 * cannot forget a field.
 */
interface Answer {
  /**
   *   "speaking"  the stream is carrying speech (or a pause shorter than
   *               ANSWER_TAIL_SILENCE_MS inside it); deltas go to the device.
   *   "settled"   between answers: idle silence is dropped here.
   */
  phase: "speaking" | "settled";
  /** Silence received since the last speech in this answer, in audio ms —
   * the counter that ends it. */
  trailingSilenceMs: number;
}

/** The between-answers state: nothing playing, nothing owed. */
const freshAnswer = (): Answer => ({ phase: "settled", trailingSilenceMs: 0 });

/** One speaker's open transcript row: fragments not yet closed by a gap. */
interface TurnBuffer {
  text: string;
  /** Session timeline, both ends. */
  startTimelineMs: number;
  endTimelineMs: number;
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
  /** The local activation this server call belongs to. */
  readonly activation: string;
  /** This dial's own identity, for keys that must not collide with the
   * previous dial of the SAME call — a timestamp is not enough on a virtual
   * clock. */
  readonly dialId: string;
  /** The provider's socket, or null while the dial is still in flight. */
  socket: WebSocket | null;
  /** True once `session.started` arrived and audio may flow. */
  ready: boolean;
  /**
   * Frames awaiting hand-over to the stream, oldest first — the delta's own
   * base64, or an empty frame carrying the end marker. NUMBERED WHEN SENT,
   * not when queued, so an obituary that drops queued frames leaves no hole
   * in the numbering. In the ordinary course this holds one frame for the
   * duration of one append.
   */
  speakerOutbox: { pcm: string; lastFrameOfAnswer?: true }[];
  /**
   * ONE sender per live dial, started with its first output and waiting while
   * the outbox is empty. One keepalive registration per dial: registering it
   * per FRAME (ten a second) arms the
   * recovery record and its alarm ten times a second, each a storage write
   * ahead of the append — measured 2026-09-11 as one frame reaching the
   * device every ~1.5 s while the provider sent ten.
   */
  sending: boolean;
  /** Wakes the sender waiting on an empty outbox; null while it is sending or gone. */
  wakeSender: (() => void) | null;
  /** Facet clock at the last speaker frame handed over — the "this end is
   * busy" reading the idle deadline uses. */
  lastSpeakerFrameAtFacetMs: number;
  /** Last speaker-frame sequence number minted, for this call. */
  lastDeviceSpeakerFrameSeq: number;
  /**
   * The next frame out must tell the device to empty its speaker first.
   * TRUE FROM THE MOMENT THE DIAL IS DECIDED: the device may still hold
   * frames from the incarnation that died, numbered higher than the ones
   * about to arrive. Consumed by the sender.
   */
  clearSpeakerBufferBeforeNextFrame: boolean;
  /** The face, when the certificate says something renders one; null costs nothing. */
  face: ReturnType<typeof createFace> | null;
  /**
   * The backend decided the call is over, with this reason; the call ends
   * once the goodbye's end marker has gone out (or the grace runs out).
   * Runtime on purpose: evicted, the idle deadline backstops.
   */
  hangUpReason: string | null;
  /** Facet clock when the hang-up was decided — see HANG_UP_GOODBYE_GRACE_MS. */
  hangUpArmedAtFacetMs: number;
  /** An acknowledgement already playing at the decision is not the goodbye. */
  answerBeforeHangUp: Answer | null;
  /** Bounded conversation context, including turns closed since the dial began. */
  transcript: TranscriptTurn[];
  /** The answer in flight — replaced wholesale at the onset of speech. */
  answer: Answer;
  /** Facet clock at the last user transcript fragment. */
  lastUserFragmentAtFacetMs: number | null;
  /** How far, on the facet clock, the device's forwarded audio reaches:
   * each forwarded chunk extends it by its own duration (from now, if it had
   * fallen behind), so a burst of 500 ms sent in one append covers the next
   * 500 ms and the silence fill starts only past it — filling INSIDE a
   * burst chops the person's words with silence (measured: "count to sixty"
   * reached the model as "count to six"). */
  micAudioCoveredUntilFacetMs: number;
  /** Silence frames this dial has sent in the device's place. */
  silenceFillFrames: number;
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
const freshDial = (conversationId: string, activation: string): Dial => ({
  conversationId,
  activation,
  dialId: crypto.randomUUID(),
  socket: null,
  ready: false,
  speakerOutbox: [],
  sending: false,
  wakeSender: null,
  lastSpeakerFrameAtFacetMs: 0,
  lastDeviceSpeakerFrameSeq: 0,
  clearSpeakerBufferBeforeNextFrame: true,
  face: null,
  hangUpReason: null,
  hangUpArmedAtFacetMs: 0,
  answerBeforeHangUp: null,
  transcript: [],
  answer: freshAnswer(),
  lastUserFragmentAtFacetMs: null,
  micAudioCoveredUntilFacetMs: 0,
  silenceFillFrames: 0,
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
    dialProvider(): Promise<WebSocket | null>;
    /**
     * Open a fresh project itx session, use it, dispose it. Stubs from
     * `env.ITX.get()` must not outlive the invocation that dialed them, so
     * every backend function opens its own — the SDK's own pattern.
     */
    withProject<T>(fn: (project: Project) => Promise<T>): Promise<T>;
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
  /** Capture that arrived before this dial's handshake finished, oldest first. */
  #micQueue: string[] = [];
  /** Decoded PCM bytes in #micQueue; the provider accepts variable payloads. */
  #micQueueBytes = 0;
  /**
   * A call has been ASKED for, and the log has not caught up yet. A board
   * streams microphone frames continuously, so the window between asking
   * and the fold showing a call is never empty — without this every frame in
   * it minted its own conversation.
   */
  #callRequestedForActivation: string | null = null;
  /**
   * The fold's `lastDeviceInputAtStreamMs`, refreshed on every delivery. A
   * MIRROR, never a second source of truth: the idle loop runs between
   * deliveries and has no way to read the fold.
   */
  #lastDeviceInputAtStreamMsMirror = 0;
  /** The activation whose terminal event is still travelling through the log. */
  #endingActivation: string | null = null;
  /** Closed rows still travelling to the Agent; see #closeTurn. */
  #pendingTranscriptContexts = new Map<string, AgentTranscriptContext>();
  /** Agent context writes share keys, so their invocation order is their overwrite order. */
  #agentAppendTail: Promise<void> = Promise.resolve();
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
         * than survives. */
        return {
          ...state,
          instructions: event.payload.instructions ?? "",
          visemes: event.payload.visemes ?? false,
          backend: event.payload.backend || {},
        };

      case "events.iterate.com/voice-agent/call-started":
        /* The id was minted INTO the event rather than here, so this is
         * deterministic under replay. The deadline starts here too: opening a
         * call IS the device saying something. */
        if (state.call || recentEndedActivations(state).includes(event.payload.activation)) {
          return state;
        }
        return {
          ...state,
          call: {
            conversationId: event.payload.conversationId,
            activation: event.payload.activation,
            lastDeviceInputAtStreamMs: committedAtStreamMs,
          },
        };

      case "events.iterate.com/voice-agent/mic-frame":
        /* Their BODIES never reach the fold, but their commit stamps are as
         * durable as any event's, and folding the newest is what makes the
         * idle deadline outlive an eviction. `max` so a redelivered batch
         * cannot walk the deadline backwards. */
        return !state.call ||
          state.call.activation !== event.payload.activation ||
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

      case "events.iterate.com/voice-agent/keepalive":
        return !state.call ||
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

      case "events.iterate.com/voice-agent/conversation-ended":
        /* Retain both terminals the client can have in flight. A late A must
         * not erase B's fence, and a B terminal before its first mic must
         * still block that mic. */
        if (!state.call) {
          return {
            ...state,
            lastEndedActivation: null,
            recentEndedActivations: rememberEndedActivation(state, event.payload.activation),
          };
        }
        return state.call.activation !== event.payload.activation
          ? state
          : {
              ...state,
              call: null,
              lastEndedActivation: null,
              recentEndedActivations: rememberEndedActivation(state, event.payload.activation),
            };

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
          transcript: foldTranscriptTurn(state.transcript, {
            role: "assistant",
            text: event.payload.text,
          }),
        };
      }

      default:
        return state;
    }
  }

  /* ----------------------------------------------------------------- react */

  processEvent(args: ProcessEventArgs<VoiceAgentContract>): undefined {
    const { state, event, delivery, append, runInBackground } = args;

    /* The log has caught up with an opening append we were remembering. */
    if (state.call !== null) {
      this.#callRequestedForActivation = null;
      this.#lastDeviceInputAtStreamMsMirror = state.call.lastDeviceInputAtStreamMs;
    }

    /* A provider session is volatile. Its durable record cannot revive it. */
    const owedCall = delivery.caughtUp ? state.call : null;
    if (owedCall && this.#dial?.activation !== owedCall.activation) {
      args.blockProcessorWhile(() =>
        this.#end(owedCall.activation, "the voice session was interrupted", append),
      );
    }

    if (event === null) return;

    switch (event.type) {
      case "events.iterate.com/voice-agent/utterance-transcript":
      case "events.iterate.com/voice-agent/answer-transcript": {
        const transcriptKey = event.payload.key || `voice-agent/transcript:${event.offset}`;
        /* This is a per-event consequence: its stable key is the committed
         * transcript row, not its text, so repeated words remain distinct. */
        args.blockProcessorWhile(() =>
          this.#appendAgentContext(() =>
            this.deps.withProject(async (project) => {
              await project.agents.get(this.path).append({
                type: "events.iterate.com/agents/context-added",
                idempotencyKey: this.idempotencyKey(`agent-observed-transcript:${event.offset}`),
                payload: {
                  ...agentTranscriptContext(
                    event.type === "events.iterate.com/voice-agent/utterance-transcript"
                      ? "user"
                      : "assistant",
                    event.payload.text,
                  ),
                  actor: { type: "integration", name: "voice-agent" },
                  key: transcriptKey,
                  llmRequestPolicy: { behaviour: "dont-trigger-request" },
                },
              });
              this.#pendingTranscriptContexts.delete(transcriptKey);
            }),
          ),
        );
        return;
      }

      case "events.iterate.com/voice-agent/instructions":
      case "events.iterate.com/voice-agent/thinking":
      case "events.iterate.com/voice-agent/commentary": {
        const dial = this.#dial;
        const update = event.payload;
        if (!dial || dial.activation !== update.activation) return;
        const sessionType =
          event.type === "events.iterate.com/voice-agent/instructions"
            ? "instructions"
            : event.type === "events.iterate.com/voice-agent/thinking"
              ? "thinking"
              : "commentary";
        if (event.type === "events.iterate.com/voice-agent/commentary" && event.payload.hangUp) {
          dial.hangUpReason = "the Agent hung up";
          dial.hangUpArmedAtFacetMs = this.deps.nowAtFacetMs();
          dial.answerBeforeHangUp = dial.answer;
          runInBackground(async () => {
            await this.deps.sleep(HANG_UP_GOODBYE_GRACE_MS);
            if (this.#dial !== dial || dial.answer.phase === "speaking") return;
            await this.#settleHangUp(dial, append);
          });
        }
        let chunkIndex = 0;
        for (const content of commentaryChunks(update.content)) {
          this.#sendControl(dial, {
            type: `session.${sessionType}.append`,
            event_id: `agent_${event.offset}_${chunkIndex++}`,
            delegation_id: update.delegationId,
            content,
          });
        }
        return;
      }

      case "events.iterate.com/voice-agent/mic-frame": {
        /* NOT DECODED HERE, on purpose. The frame stays the device's own
         * base64 string all the way to the wire. */
        const micB64 = event.payload.pcm;
        const activation = event.payload.activation;
        /* An empty frame is a client bug, not audio: the provider rejects
         * "audio/pcm audio must not be empty" and it can open no call. */
        if (micB64 === "") return;
        /* Input only ever reaches the matching local activation. A client
         * output is ordered, so a mic from an ended activation must not
         * arrive after its successor has itself ended. */
        if (state.call && state.call.activation !== activation) return;
        if (!state.call && recentEndedActivations(state).includes(activation)) return;
        if (!state.call && this.#endingActivation === activation) return;
        if (!state.call && this.#callRequestedForActivation !== activation) {
          const conversationId = `conv_${crypto.randomUUID()}`;
          this.#callRequestedForActivation = activation;
          /* THE IDLE DEADLINE ARMS AT MINT: opening a call IS the device's
           * initial input. `max` so a mint can never walk a fresher stamp back. */
          this.#lastDeviceInputAtStreamMsMirror = Math.max(
            this.#lastDeviceInputAtStreamMsMirror,
            this.deps.nowAtFacetMs(),
          );
          /* The call is not live until this append succeeds. */
          args.blockProcessorWhile(() =>
            append({
              type: "events.iterate.com/voice-agent/call-started",
              idempotencyKey: this.idempotencyKey(`call:${activation}`),
              payload: { activation, conversationId },
            }).catch((error: unknown) => {
              if (this.#callRequestedForActivation === activation) {
                this.#callRequestedForActivation = null;
              }
              if (this.#dial?.activation === activation) this.#hangUp();
              throw error;
            }),
          );
          /*
           * DIAL NOW, NOT WHEN THE LOG AGREES. Waiting for the append to come
           * back and be folded put a full stream round trip in front of every
           * first word — measured at 7.4 seconds. And NO return: the frame
           * that opened the call falls through to the hold site below.
           */
          this.#openProviderConnection(conversationId, activation, state, append, runInBackground);
        }

        const dial = this.#dial;
        if (dial && dial.activation === activation && dial.ready && dial.socket) {
          const nowAtFacetMs = this.deps.nowAtFacetMs();
          dial.micAudioCoveredUntilFacetMs =
            Math.max(dial.micAudioCoveredUntilFacetMs, nowAtFacetMs) +
            base64ByteLength(micB64) / PCM16_BYTES_PER_MS;
          this.#sendMicAudio(dial.socket, micB64);
        } else {
          const micBytes = base64ByteLength(micB64);
          const openingDial = dial?.activation === activation ? dial : null;
          if (!openingDial) return;
          if (this.#micQueueBytes + micBytes <= MAX_HELD_MIC_BYTES) {
            this.#micQueue.push(micB64);
            this.#micQueueBytes += micBytes;
            return;
          }
          this.#hangUp();
          runInBackground(() =>
            this.#end(
              activation,
              `the provider did not become ready before ${MAX_HELD_MIC_BYTES / 32}ms of microphone audio accumulated`,
              append,
            ),
          );
        }
        return;
      }

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
        const dial = this.#dial;
        if (dial && dial.activation === event.payload.activation) {
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
   * The mint dials immediately: waiting for the log to fold `call-started`
   * puts a stream round trip in front of the first word.
   */
  #openProviderConnection(
    conversationId: string,
    activation: string,
    state: ProcessEventArgs<VoiceAgentContract>["state"],
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    if (this.#dial !== null) return;
    /* CREATED BEFORE THE AWAITED DIAL, so a second caller finds `#dial`
     * taken and the mic path queues for the whole handshake. */
    const dial = freshDial(conversationId, activation);
    dial.transcript = state.transcript;
    if (state.visemes) dial.face = createFace();
    this.#dial = dial;
    const dialStartedAtFacetMs = this.deps.nowAtFacetMs();
    runInBackground(async () => {
      await this.deps.sleep(OPENING_DEADLINE_MS);
      if (this.#dial !== dial || dial.ready) return;
      this.#dial = null;
      try {
        dial.socket?.close();
      } catch {
        /* Already gone. */
      }
      await this.#end(
        activation,
        `the provider did not become ready within ${OPENING_DEADLINE_MS}ms`,
        append,
      );
    });
    runInBackground(async () => {
      /* A dial can REJECT (DNS, TLS), not just refuse — and an uncaught
       * throw here was measured as sixty seconds of dead air. A throw IS a
       * refusal, and both failures share one exit. */
      let socket: WebSocket | null = null;
      let failure = "the provider refused the connection";
      try {
        socket = await this.deps.dialProvider();
      } catch (error) {
        failure = `the provider dial failed: ${String(error).slice(0, 200)}`;
      }
      if (socket === null) {
        if (this.#dial !== dial) return;
        this.#dial = null;
        await this.#end(activation, failure, append);
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
       * THE THIRD SWITCH, AND WHY IT IS NOT A STREAM EVENT. Everything else
       * in this file reaches `processEvent` by being appended. The provider's
       * messages do not, and the reason is measured rather than stylistic:
       * ephemeral delivery coalesces, delivering in clumps seconds late.
       * Routing an audio delta through it would put a full stream round trip
       * in front of every word.
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
        this.#onLiveEvent(
          dial,
          live,
          type,
          receivedAtFacetMs,
          dialStartedAtFacetMs,
          append,
          runInBackground,
        );
        /* THE METRONOME: every message — the 10 Hz audio stream above all —
         * moves the session timeline, and a transcript row TURN_GAP_MS behind
         * it is a finished turn. No timer anywhere. */
        this.#flushTurns(dial, append, false);
      });

      socket.addEventListener("close", (event: CloseEvent) => {
        if (this.#dial !== dial) return;
        this.#dial = null;
        this.#flushTurns(dial, append, true);
        this.#providerClosed(
          conversationId,
          activation,
          `the provider's socket closed (${String(event.code)}${event.reason ? ` ${event.reason}` : ""})`,
          append,
          runInBackground,
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
       * hearing out a long answer sends nothing, so the answer's frames
       * count too — `lastSpeakerFrameAtFacetMs` is when this end last
       * spoke. In-memory ON PURPOSE: after an eviction nothing was said, and
       * the durable stamp alone still bites.
       */
      const lastActivityAtFacetMs = Math.max(
        this.#lastDeviceInputAtStreamMsMirror,
        dial.lastSpeakerFrameAtFacetMs,
      );
      if (nowAtFacetMs - lastActivityAtFacetMs < IDLE_TIMEOUT_MS) {
        runInBackground(idleTick);
        return;
      }
      await this.#end(
        activation,
        `no input from the device for ${IDLE_TIMEOUT_MS / 1000}s`,
        append,
      );
    };
    runInBackground(idleTick);
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
    if (!dial.socket) return;
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

    this.runInBackground(() =>
      append({
        type: "events.iterate.com/voice-agent/session-configured",
        idempotencyKey: this.idempotencyKey(`session-configured:${dial.dialId}`),
        payload: {
          activation: dial.activation,
          conversationId: dial.conversationId,
          provider: "gpt-live",
          instructions: instructions.slice(0, 8_000),
          delegation: "client",
        },
      }),
    );
    dial.socket.send(
      JSON.stringify({
        type: "session.start",
        event_id: `start_${dial.dialId}`,
        session: {
          model: LIVE.model,
          instructions,
          ...(input.length > 0 && { input }),
          audio: {
            format: { type: "audio/pcm", rate: LIVE.rate },
            output: { voice: LIVE.voice },
          },
          delegation: { type: "client" },
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
        this.#micQueueBytes = 0;
        dial.micAudioCoveredUntilFacetMs = receivedAtFacetMs;
        this.#startSilenceFill(dial, append, runInBackground);
        this.runInBackground(() =>
          append({
            type: "events.iterate.com/voice-agent/conversation-accepted",
            /* Per dial: each provider session reports its own handshake time. */
            idempotencyKey: this.idempotencyKey(`accepted:${conversationId}:${dial.dialId}`),
            payload: {
              activation: dial.activation,
              conversationId,
              handshakeTookMs: receivedAtFacetMs - dialStartedAtFacetMs,
              heldMicFrames,
            },
          }),
        );
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
          dial.lastUserFragmentAtFacetMs = receivedAtFacetMs;
        }
        const startTimelineMs = typeof live.start_ms === "number" ? live.start_ms : dial.timelineMs;
        const endTimelineMs = typeof live.end_ms === "number" ? live.end_ms : startTimelineMs;
        dial.timelineMs = Math.max(dial.timelineMs, endTimelineMs);
        const open = dial.turns[speaker];
        if (open && startTimelineMs - open.endTimelineMs >= TURN_GAP_MS) {
          /* A fragment landing well after the row's last: the row was a
           * finished turn (the metronome usually closes it first; this is
           * the fragment arriving faster than the audio). */
          this.#closeTurn(dial, speaker, append);
        }
        const row = dial.turns[speaker];
        if (!row) {
          dial.turns[speaker] = {
            text: live.delta,
            startTimelineMs,
            endTimelineMs,
          };
        } else {
          row.text += live.delta;
          row.endTimelineMs = Math.max(row.endTimelineMs, endTimelineMs);
        }
        return;
      }

      case "session.delegation.created": {
        const parsed = z
          .object({
            delegation: z.object({ id: z.string().min(1).max(128), target: z.literal("client") }),
          })
          .safeParse(live);
        if (!parsed.success) return;
        this.#delegate(dial, parsed.data.delegation.id, append);
        return;
      }

      case "session.closed": {
        /* The provider finalized the session. The close handler records the
         * classified terminal outcome. */
        this.#flushTurns(dial, append, true);
        if (this.#dial === dial) this.#dial = null;
        this.#providerClosed(
          conversationId,
          dial.activation,
          `the provider closed the session (${String(live.reason ?? "unknown")})`,
          append,
          runInBackground,
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
        /* Acknowledgements and usage updates require no audio action. */
        return;
    }
  }

  /**
   * One 100 ms delta of the provider's CONTINUOUS output stream.
   *
   * THE STREAM NEVER STOPS, so "is the voice speaking" is read off the audio
   * itself: a delta is speech or it is silence. Idle silence is dropped here
   * — the device's ring being empty IS silence, and the downlink carries
   * speech only. Speech opens an answer (a fresh Answer, the face told) and
   * goes straight to the device; silence inside an answer rides along up to
   * ANSWER_TAIL_SILENCE_MS so the natural pauses play; silence past that
   * ends the answer, and `lastFrameOfAnswer` follows the last frame out.
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

    if (dial.answer.phase === "settled") {
      if (!speaking) return;
      /* THE ONSET: a new answer, replaced wholesale. */
      dial.answer = { phase: "speaking", trailingSilenceMs: 0 };
      dial.face?.answerStarted();
    } else if (speaking) {
      dial.answer.trailingSilenceMs = 0;
    } else {
      dial.answer.trailingSilenceMs += deltaMs;
      if (dial.answer.trailingSilenceMs >= ANSWER_TAIL_SILENCE_MS) {
        /* THE ANSWER IS OVER, and the device does have to be told: silence
         * on the wire is indistinguishable from a provider taking its time,
         * so a client waiting for the end of a turn waits for ever. */
        this.#endAnswer(dial, receivedAtFacetMs, append, runInBackground);
        return;
      }
    }

    /* STRAIGHT THROUGH. The provider's 16 kHz bytes ARE the pipeline's
     * bytes, so the delta goes out as the base64 it arrived as — GPT-Live's
     * 100 ms delta is exactly the device's frame ceiling. A larger delta
     * (no provider sends one today) is decoded and cut, because the device
     * silently drops an oversize frame. */
    if (base64ByteLength(delta) <= MAX_SPEAKER_PAYLOAD_BYTES) {
      this.#sendSpeakerFrame(dial, delta, receivedAtFacetMs, append, runInBackground);
      return;
    }
    const pcm16 = base64ToBytes(delta);
    for (let cut = 0; cut < pcm16.length; cut += MAX_SPEAKER_PAYLOAD_BYTES) {
      this.#sendSpeakerFrame(
        dial,
        bytesToBase64(pcm16.subarray(cut, Math.min(cut + MAX_SPEAKER_PAYLOAD_BYTES, pcm16.length))),
        receivedAtFacetMs,
        append,
        runInBackground,
      );
    }
  }

  /**
   * One frame to the device, now, with the next sequence number. The face
   * folds at hand-over time, on the frame the device is about to play; the
   * clear a fresh dial owes rides on its first frame.
   */
  #sendSpeakerFrame(
    dial: Dial,
    pcm: string,
    nowAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    dial.face?.audio(base64ToBytes(pcm), nowAtFacetMs);
    dial.lastSpeakerFrameAtFacetMs = nowAtFacetMs;
    dial.speakerOutbox.push({ pcm });
    this.#startSpeakerSender(dial, append, runInBackground);
  }

  /**
   * The answer ended: the mouth closes, the marker goes out behind the last
   * frame, and a hang-up armed before this answer ended is now settleable.
   */
  #endAnswer(
    dial: Dial,
    nowAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    const endedAnswer = dial.answer;
    dial.answer = freshAnswer();
    dial.face?.answerAudioDone(nowAtFacetMs);
    dial.speakerOutbox.push({ pcm: "", lastFrameOfAnswer: true });
    this.#startSpeakerSender(dial, append, runInBackground);
    if (
      dial.hangUpReason &&
      (endedAnswer !== dial.answerBeforeHangUp ||
        nowAtFacetMs - dial.hangUpArmedAtFacetMs >= HANG_UP_GOODBYE_GRACE_MS)
    ) {
      /* The goodbye has been handed over whole; the device holds at most its
       * own small buffer. */
      runInBackground(async () => {
        await this.deps.sleep(GOODBYE_PLAYOUT_ALLOWANCE_MS);
        await this.#settleHangUp(dial, append);
      });
    }
  }

  /**
   * End the call the backend asked to end — unless the dial is already gone.
   * Idempotent: the reason is consumed on the way out.
   */
  async #settleHangUp(
    dial: Dial,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): Promise<void> {
    if (this.#dial !== dial || !dial.hangUpReason) return;
    const reason = dial.hangUpReason;
    dial.hangUpReason = null;
    await this.#end(dial.activation, reason, append);
  }

  /**
   * Send queued speaker frames in order for the lifetime of the dial.
   * Assign sequence numbers and timestamps at append time so instrumentation
   * distinguishes sender delays from network delays. A rejected append ends
   * the call: losing audio, the initial clear, or the answer's final marker
   * cannot be recovered by continuing with the next frame.
   */
  #startSpeakerSender(
    dial: Dial,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    if (dial.sending) {
      dial.wakeSender?.();
      return;
    }
    dial.sending = true;
    runInBackground(async () => {
      try {
        while (this.#dial === dial) {
          const frame = dial.speakerOutbox.shift();
          if (!frame) {
            /* ONE REGISTRATION PER DIAL, NOT PER DELTA. An append finishes in
             * a millisecond and the next delta comes a hundred later, so a
             * sender that let go when the outbox drained re-registered for
             * nearly every frame — ten storage writes and alarm arms a
             * second inside the Durable Object. Measured on preview-7
             * (2026-09-11 afternoon, `voicelab duplex`): provider→facet gaps
             * p99 456 ms while the facet's own sends gapped p99 5.1 s, max
             * 9.6 s, and a mic append's round trip reached 4.3 s. The sender
             * now waits for the next frame; the tick is only so a dial that
             * ended is noticed. */
            await this.#waitForWork((wake) => {
              dial.wakeSender = wake;
            }, BACKGROUND_LOOP_TICK_MS);
            dial.wakeSender = null;
            continue;
          }
          const clearFirst = dial.clearSpeakerBufferBeforeNextFrame;
          dial.clearSpeakerBufferBeforeNextFrame = false;
          try {
            await append({
              type: "events.iterate.com/voice-agent/spk-frame",
              payload: {
                activation: dial.activation,
                conversationId: dial.conversationId,
                deviceSpeakerFrameSeq: ++dial.lastDeviceSpeakerFrameSeq,
                pcm: frame.pcm,
                ...(clearFirst && { clearSpeakerBufferBeforeFrame: true }),
                ...(frame.lastFrameOfAnswer && { lastFrameOfAnswer: true }),
                sentAtFacetMs: this.deps.nowAtFacetMs(),
              },
            });
          } catch {
            await this.#end(
              dial.activation,
              "the device speaker frame could not be appended",
              append,
            );
            return;
          }
        }
      } finally {
        dial.sending = false;
        dial.wakeSender = null;
      }
    });
  }

  /**
   * Resolves when `wake` is called or after `tickMs`, whichever is first: a
   * background loop's way of sleeping without giving up its registration.
   */
  #waitForWork(arm: (wake: () => void) => void, tickMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      arm(resolve);
      void this.deps.sleep(tickMs).then(resolve);
    });
  }

  #flushTurns(
    dial: Dial,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    force: boolean,
  ): void {
    for (const speaker of ["user", "assistant"] as const) {
      const row = dial.turns[speaker];
      if (!row) continue;
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
    if (!row) return;
    const text = row.text.replace(/\s+/g, " ").trim();
    if (text === "") return;
    dial.transcript = foldTranscriptTurn(dial.transcript, {
      role: speaker === "user" ? "listener" : "assistant",
      text,
    });
    const key = `live-turn:${dial.dialId}:${speaker}:${String(row.startTimelineMs)}`;
    const transcriptKey = `voice-agent/transcript:${dial.dialId}:${speaker}:${String(row.startTimelineMs)}`;
    this.#pendingTranscriptContexts.set(transcriptKey, agentTranscriptContext(speaker, text));
    this.runInBackground(() =>
      speaker === "user"
        ? append({
            type: "events.iterate.com/voice-agent/utterance-transcript",
            idempotencyKey: this.idempotencyKey(key),
            payload: { conversationId: dial.conversationId, text, key: transcriptKey },
          })
        : append({
            type: "events.iterate.com/voice-agent/answer-transcript",
            idempotencyKey: this.idempotencyKey(key),
            payload: { conversationId: dial.conversationId, text, key: transcriptKey },
          }),
    );
  }

  #startSilenceFill(
    dial: Dial,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    runInBackground(async () => {
      while (this.#dial === dial && dial.socket && dial.ready) {
        await this.deps.sleep(SILENCE_FILL_MS);
        if (this.#dial !== dial || !dial.socket || !dial.ready) return;
        /* PACED TO THE WALL CLOCK, never to the loop: a sleep that wakes
         * late still owes the provider every millisecond since the device
         * was last heard, so as many whole frames as are owed go out — an
         * input stream that drifts even a few percent slow starves the
         * provider's clock a few seconds into a long answer. Device audio
         * moves the stamp forward itself, so the fill covers only the gaps. */
        const nowAtFacetMs = this.deps.nowAtFacetMs();
        let owedMs = nowAtFacetMs - dial.micAudioCoveredUntilFacetMs;
        if (owedMs > MAX_SILENCE_FILL_CATCH_UP_MS) {
          await this.#end(
            dial.activation,
            `the provider input clock fell ${owedMs}ms behind`,
            append,
          );
          return;
        }
        while (owedMs >= SILENCE_FILL_MS) {
          dial.micAudioCoveredUntilFacetMs += SILENCE_FILL_MS;
          owedMs -= SILENCE_FILL_MS;
          this.#sendMicAudio(dial.socket, SILENCE_FILL_FRAME_B64);
          dial.silenceFillFrames += 1;
        }
      }
    });
  }

  #sendMicAudio(socket: WebSocket, b64: string): void {
    const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    socket.send(JSON.stringify({ type: "session.input_audio.append", audio: padded }));
  }

  /** A provider close ends the uncertain session; it is never replayed. */
  #providerClosed(
    conversationId: string,
    activation: string,
    reason: string,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    /* The dial's state snapshot predates its own call-started fold, so the
     * call's standing is read from this instance: an end already requested
     * for it, or a conversation ended since the dial began, is not ours. */
    if (this.#endingActivation === activation) {
      return;
    }
    runInBackground(async () => {
      await this.#end(activation, reason, append);
      await append({
        type: "events.iterate.com/voice-agent/provider-disconnected",
        payload: { conversationId, reason },
      });
    });
  }

  async #end(
    activation: string,
    reason: string,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): Promise<void> {
    if (this.#endingActivation === activation) return;
    this.#endingActivation = activation;
    const dial = this.#dial;
    if (dial?.activation === activation) {
      this.#flushTurns(dial, append, true);
      this.#clearDeviceSpeaker(dial, this.deps.nowAtFacetMs(), append);
      this.#hangUp();
    }
    try {
      await append({
        type: "events.iterate.com/voice-agent/conversation-ended",
        idempotencyKey: this.idempotencyKey(`ended:${activation}`),
        payload: { activation, reason },
      });
    } catch (error) {
      if (this.#endingActivation === activation) this.#endingActivation = null;
      throw error;
    }
  }

  /* ------------------------------------------------------------- Agent */

  /**
   * One client delegation becomes durable Agent context immediately. Its
   * metadata is platform context, separate from untrusted spoken text; the
   * Agent sees later completed transcript rows as additional context.
   */
  #delegate(
    dial: Dial,
    delegationId: string,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    this.runInBackground(() =>
      this.#appendAgentContext(async () => {
        try {
          await this.deps.withProject(async (project) => {
            const transcriptSnapshots = this.#transcriptSnapshots(dial, delegationId);
            await project.agents.get(this.path).append(...transcriptSnapshots, {
              type: "events.iterate.com/agents/context-added",
              idempotencyKey: this.idempotencyKey(
                `agent-delegation:${dial.dialId}:${delegationId}`,
              ),
              payload: {
                role: "developer",
                content: [
                  "Voice delegation metadata (platform context, not user speech):",
                  JSON.stringify({ activation: dial.activation, delegationId }),
                  "Handle the request in the conversation transcript for this client delegation. Send information back through the voice events explained above, preserving these IDs.",
                  "Completed transcript context may arrive later.",
                ].join("\n"),
                llmRequestPolicy: { behaviour: "after-current-request" },
              },
            });
            if (this.#dial === dial) {
              this.#sendControl(dial, {
                type: "session.thinking.append",
                delegation_id: delegationId,
                content: "The request was handed to the backend; the conversation may continue.",
              });
            }
          });
        } catch (error) {
          if (this.#dial !== dial) return;
          await this.#end(
            dial.activation,
            `the Agent handoff could not be recorded: ${String(error).slice(0, 200)}`,
            append,
          );
        }
      }),
    );
  }

  #transcriptSnapshots(dial: Dial, delegationId: string): AgentEventInput[] {
    return [
      ...Array.from(this.#pendingTranscriptContexts, ([key, { role, content }]) =>
        this.#transcriptSnapshot(key, role, content, delegationId),
      ),
      ...(["user", "assistant"] as const).flatMap((speaker) => {
        const row = dial.turns[speaker];
        const content = row?.text.replace(/\s+/g, " ").trim() ?? "";
        if (!row || content === "") return [];
        const key = `voice-agent/transcript:${dial.dialId}:${speaker}:${String(row.startTimelineMs)}`;
        const transcript = agentTranscriptContext(speaker, content);
        return [this.#transcriptSnapshot(key, transcript.role, transcript.content, delegationId)];
      }),
    ];
  }

  #transcriptSnapshot(
    key: string,
    role: AgentTranscriptContext["role"],
    content: string,
    delegationId: string,
  ): AgentEventInput {
    return {
      type: "events.iterate.com/agents/context-added",
      idempotencyKey: this.idempotencyKey(`agent-delegation-transcript:${key}:${delegationId}`),
      payload: {
        role,
        actor: { type: "integration", name: "voice-agent" },
        key,
        content,
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    };
  }

  #appendAgentContext(work: () => Promise<void>): Promise<void> {
    const next = this.#agentAppendTail.then(work);
    /* This catch only releases the next queued write; callers still receive
     * `next` and their runner/background policy records its rejection. */
    this.#agentAppendTail = next.catch(() => {});
    return next;
  }

  /**
   * Send one client command to the provider.
   */
  #sendControl(dial: Dial, message: Record<string, unknown>): void {
    if (!dial.socket) return;
    dial.socket.send(JSON.stringify(message));
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
   * Tell the device to empty its speaker: the call is over and it is holding
   * dead audio. THE CLEAR RIDES ON A FRAME, and an empty one is still a
   * frame — it carries the next sequence number, so the device orders it
   * after everything it cancels.
   */
  #clearDeviceSpeaker(
    dial: Dial,
    decidedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    /* Frames still waiting here would play AFTER the clear; they go first.
     * Numbered at the send, so dropping them leaves no hole. */
    dial.speakerOutbox = [];
    /* Sent directly, not through the sender: the obituary path clears and
     * then buries the dial in the same breath, and the clear must still go. */
    const clearFrameSeq = ++dial.lastDeviceSpeakerFrameSeq;
    this.runInBackground(() =>
      append({
        type: "events.iterate.com/voice-agent/spk-frame",
        payload: {
          activation: dial.activation,
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
   * Let the dial and everything hanging off it go. Safe to call twice. The
   * provider is asked to close first — `session.close` is what makes it
   * finalize usage — and the socket is closed behind it without waiting: a
   * hang-up must not depend on the far end's manners.
   */
  #hangUp(): void {
    this.#micQueue = [];
    this.#micQueueBytes = 0;
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
 * Open the provider's WebSocket. No query parameters — the model rides
 * `session.start` — and the bearer is the platform's `getSecret` grammar,
 * substituted at egress so the key never enters this isolate.
 */
export async function dialProviderSocket(): Promise<WebSocket | null> {
  const response = await fetch(LIVE.url, {
    headers: { Upgrade: "websocket", Authorization: `Bearer getSecret("${OPENAI_SECRET}")` },
  });
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
    {
      const providerSecret = project.secrets.get(OPENAI_SECRET);
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
          `voice-agent setup requires secret "${OPENAI_SECRET}" with material. Create it with ` +
            `await itx.secrets.get("${OPENAI_SECRET}").create({ egress: { urls: ["${new URL(LIVE.url).origin}"] }, ` +
            `material: "<API key>" }); then rerun. This agent never creates or copies credentials.`,
        );
      }
    }

    /* The ordinary Agent shares this stream with the VoiceAgent. Its durable
     * protocol is installed once; a model changes only when setup explicitly
     * asks for one, leaving the normal Agent configuration intact otherwise. */
    const setupId = crypto.randomUUID();
    const agent = project.agents.get(streamPath);
    await agent.create();
    await agent.append(...agentSetupEvents(streamPath, options.backend?.model, setupId));

    const stream = project.streams.get(streamPath);
    try {
      /*
       * BIRTH AND CONFIGURATION, SPLIT. `created` is existence only, under a
       * key with nothing but the stream path in it. The configuration is an
       * ordinary event, keyed per SETUP RUN so every run applies.
       */
      const { streamPath: _streamPath, reinstall: _reinstall, ...configPayload } = options;
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
      dialProvider: dialProviderSocket,
      withProject: async <T>(fn: (project: Project) => Promise<T>): Promise<T> => {
        const project = (await this.env.ITX.get()) as Project;
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
