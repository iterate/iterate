/**
 * One GPT-Live voice call as an os-next facet processor, one facet per
 * conversation context: it holds the provider socket, forwards microphone
 * frames in and speaker frames out, folds the transcript, and answers the live
 * model's delegations with one chat-model turn (delegation-turn.ts).
 */
import {
  StreamProcessor,
  StreamProcessorDurableObject,
  defineProcessorContract,
  z,
  type ConsumedEvent,
  type ProcessEventArgs,
  type ReduceArgs,
} from "./processor.js";

/** Fixed GPT-Live session configuration. */
const LIVE = {
  url: "https://api.openai.com/v1/live/sessions",
  model: "gpt-live-1",
  voice: "marin",
  rate: 16_000,
} as const;

/** 16 kHz mono PCM16: two bytes per sample, sixteen samples per millisecond. */
const PCM16_BYTES_PER_MS = 32;

/** The most audio one speaker frame may carry: one 100 ms GPT-Live delta, which fits the
 * device's 4,800-byte decoded chunk and 6,912-byte base64 buffer. */
const MAX_SPEAKER_PAYLOAD_BYTES = 3_200;

/** The device holds ten seconds of speaker audio; more than that queued here means an append
 * has stalled. */
const SPEAKER_OUTBOX_MAX_BYTES = 10_000 * PCM16_BYTES_PER_MS;

/** A transcript fragment this far (on the session timeline) after the same speaker's previous
 * one starts a new turn; the fragments themselves carry no turn boundaries. The two speakers may
 * overlap, so the open rows are per speaker. */
const TURN_GAP_MS = 1_200;

/** No input from the device for this long and the call is over. */
const IDLE_TIMEOUT_MS = 60_000;

/** GPT-Live's session timeline runs on INPUT audio, silence included; a device that goes quiet
 * starves it and an answer dies mid-sentence. Whenever no device audio covers the clock, one
 * frame of digital silence this long goes to the provider instead. */
const SILENCE_FILL_MS = 100;
const SILENCE_FILL_FRAME_B64 = bytesToBase64(new Uint8Array(SILENCE_FILL_MS * PCM16_BYTES_PER_MS));

/** The idle stamp in the fold advances in steps of this, not per frame: the deadline is a
 * minute, so most microphone batches leave the reduced state untouched. */
const IDLE_STAMP_STEP_MS = 5_000;

/** Socket creation and `session.started` must both finish within this bound. */
const OPENING_DEADLINE_MS = 15_000;

/** Commentary with `hangUp: true` arms a goodbye before GPT-Live speaks it: the call ends at the
 * first answer ending after that, or after this grace when no answer arrives. */
const HANG_UP_GOODBYE_GRACE_MS = 8_000;

/** Microphone audio held while the provider completes its handshake: 21 s covers the clients'
 * 20 s opening capture. Overflow ends the call with a reason, because keeping a truncated request
 * would tell the model a different one. */
const MAX_HELD_MIC_BYTES = 21_000 * PCM16_BYTES_PER_MS;

/** What the live model is told about the arrangement, structured the way the provider's prompting
 * guide asks (role, backchannel policy, interruption policy, a labelled delegation policy). It is
 * transparent about the backend on purpose: a model forbidden to mention it invented explanations
 * for delays. */
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

/** A fold transcript turn: who spoke, and what the provider heard them say. */
interface TranscriptTurn {
  role: "listener" | "assistant";
  text: string;
}

/** Fold one finished turn onto the recap: the newest 20 turns, each cut to 600 characters, well
 * inside the provider's 128-message / 8,192-token `input` history. */
function foldTranscriptTurn(transcript: TranscriptTurn[], turn: TranscriptTurn): TranscriptTurn[] {
  const text = turn.text.length > 600 ? `${turn.text.slice(0, 600)}…` : turn.text;
  return [...transcript, { role: turn.role, text }].slice(-20);
}

/** Each Live context append allows 500 tokens. UTF-8 bytes are a conservative upper bound,
 * independent of language and tokenizer; split at spaces where possible. */
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

/* Audio crosses this file as base64 strings: the device, the stream and GPT-Live all speak
 * 16 kHz PCM16, so a frame is never re-encoded, only measured. */

/** Bytes to base64, chunked so a long buffer cannot blow the argument list. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Decoded byte length of a base64 string, without decoding it. */
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length / 4) * 3 - padding;
}

/** All-zero bytes encode to nothing but `A`s (plus padding). */
const ALL_ZERO_BASE64 = /^A+=*$/;

/** The loudest sample in a base64 PCM16 delta. Exact digital silence, the idle stream's whole
 * content, is recognised off the string; anything else decodes once and scans. */
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

/** The device's call identity: the press mints it, the frames carry it. */
const Activation = z.string().min(1).max(64);

/** Everything that outlives the Durable Object holding the socket. No queues, no byte counts, no
 * "is speaking" flag: reduced state that depends on a buffer no restart can replay is a lie. */
const VoiceState = z.object({
  /** The rolling recap of finished turns, folded from the transcript events and seeded as history
   * into every fresh provider session, so a re-dial resumes the conversation. */
  transcript: z
    .array(z.strictObject({ role: z.enum(["listener", "assistant"]), text: z.string() }))
    .default([]),
  call: z
    .object({
      conversationId: z.string(),
      activation: Activation,
      /** When the stream committed the device's most recent input (a mic frame or a keepalive).
       * The device's input only: the agent's own speech leaves no durable event. */
      lastDeviceInputAtStreamMs: z.number(),
    })
    .nullable()
    .default(null),
  /** How the last call ended, for the live view a browser renders after hanging up. */
  lastEnd: z.object({ activation: Activation, reason: z.string() }).nullable().default(null),
});

/** What a client renders live (`itx.facets.get('voice-agent').liveSnapshot()` seeds it, the
 * `live-state/changed` deltas keep it current): the fold plus the two runtime facts a page wants. */
export type VoiceLiveView = {
  /** No call; a call whose provider dial is not ready; a live call; the last call's aftermath. */
  phase: "idle" | "dialing" | "live" | "ended";
  activation: string | null;
  /** The provider is speaking right now (the answer's frames are going to the device). */
  answering: boolean;
  transcript: TranscriptTurn[];
  lastEnd: { activation: string; reason: string } | null;
};

const VoiceAgentContract = defineProcessorContract({
  slug: "voice-agent",
  version: "1.0.0",
  description:
    "Runs a GPT-Live voice call in the conversation's own Durable Object, relaying audio both ways as it arrives.",
  stateSchema: VoiceState,
  events: {
    /* The device's half is one verb and a heartbeat: here is audio, I am still here. */
    "events.iterate.com/voice-agent/keepalive": {
      description:
        "The client's call UI is alive, said every ~20s: feeds the idle deadline so a caller " +
        "who waits quietly is not reaped at 60s of mic silence.",
      ephemeral: true,
      payloadSchema: z.strictObject({}),
    },
    "events.iterate.com/voice-agent/mic-frame": {
      description: "One capture chunk of the call named by its activation.",
      ephemeral: true,
      payloadSchema: z.looseObject({
        activation: Activation,
        /** 16 kHz mono PCM16, base64. */
        pcm: z.string(),
      }),
    },
    "events.iterate.com/voice-agent/call-started": {
      description:
        "The press opened the call: the device's activation and the conversation id derived from it.",
      payloadSchema: z.looseObject({ activation: Activation, conversationId: z.string() }),
    },
    "events.iterate.com/voice-agent/conversation-accepted": {
      description: "The provider started the session; the call is live.",
      payloadSchema: z.looseObject({
        activation: Activation,
        conversationId: z.string(),
        /** Facet clock: dial to usable. */
        handshakeTookMs: z.number(),
        /** Facet clock: dial to the provider's 101, the egress and upgrade share of the handshake. */
        upgradeTookMs: z.number().optional(),
        /** Capture held during the handshake and released in one go. */
        heldMicFrames: z.number(),
      }),
    },
    "events.iterate.com/voice-agent/conversation-ended": {
      description: "The call is over; the device appends it too (the hang-up button).",
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
    /* The durable transcript: one event per finished turn per side, grouped from the provider's
     * timeline fragments. The fold keeps a recap of these and seeds every new session with it. */
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
    "events.iterate.com/voice-agent/thinking": {
      description: "A backend note for the live model to use quietly.",
      payloadSchema: z.object({
        activation: Activation,
        delegationId: z.string().nullable(),
        content: z.string().min(1).max(8_000),
      }),
    },
    "events.iterate.com/voice-agent/commentary": {
      description: "The backend's answer for the live model to paraphrase aloud.",
      payloadSchema: z.object({
        activation: Activation,
        delegationId: z.string().nullable(),
        content: z.string().min(1).max(8_000),
        hangUp: z.boolean().optional(),
      }),
    },
    "events.iterate.com/voice-agent/delegation-requested": {
      description:
        "The live model handed a request to the backend, with the words said so far; the answer is a commentary naming the same delegationId.",
      payloadSchema: z.looseObject({
        activation: Activation,
        conversationId: z.string(),
        delegationId: z.string(),
        transcript: z.array(
          z.object({ role: z.enum(["listener", "assistant"]), text: z.string() }),
        ),
      }),
    },
    "events.iterate.com/voice-agent/spk-frame": {
      description: "One chunk of the answer, forwarded as it arrived.",
      ephemeral: true,
      payloadSchema: z.looseObject({
        activation: Activation,
        conversationId: z.string(),
        /** 16 kHz mono PCM16, base64. Empty on a frame whose only job is the end marker. */
        pcm: z.string(),
        /** Throw away everything queued, then play this frame. */
        clearSpeakerBufferBeforeFrame: z.boolean().optional(),
        /** Nothing more is coming for this answer. */
        lastFrameOfAnswer: z.boolean().optional(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/voice-agent/thinking",
    "events.iterate.com/voice-agent/commentary",
    "events.iterate.com/voice-agent/call-started",
    "events.iterate.com/voice-agent/conversation-ended",
    /* Consumed so the fold sees its own appends and the recap survives an eviction. */
    "events.iterate.com/voice-agent/utterance-transcript",
    "events.iterate.com/voice-agent/answer-transcript",
    /* Ephemeral: named here because `"*"` never matches an ephemeral event. */
    "events.iterate.com/voice-agent/mic-frame",
    "events.iterate.com/voice-agent/keepalive",
  ],
  emits: [
    "events.iterate.com/voice-agent/delegation-requested",
    "events.iterate.com/voice-agent/commentary",
    "events.iterate.com/voice-agent/thinking",
    "events.iterate.com/voice-agent/conversation-accepted",
    "events.iterate.com/voice-agent/conversation-ended",
    "events.iterate.com/voice-agent/provider-error",
    "events.iterate.com/voice-agent/provider-disconnected",
    "events.iterate.com/voice-agent/utterance-transcript",
    "events.iterate.com/voice-agent/answer-transcript",
    "events.iterate.com/voice-agent/spk-frame",
  ],
});
type VoiceAgentContract = typeof VoiceAgentContract;

type VoiceState = z.infer<typeof VoiceState>;

/** One run of speech on the provider's continuous output stream. Replaced wholesale at the onset
 * of speech, so no field can be forgotten in a reset. */
interface Answer {
  /** "speaking": deltas go to the device (pauses shorter than the tail bound included);
   * "settled": between answers, idle silence is dropped. */
  phase: "speaking" | "settled";
  /** Silence received since the last speech in this answer, in audio ms. */
  trailingSilenceMs: number;
}

const freshAnswer = (): Answer => ({ phase: "settled", trailingSilenceMs: 0 });

/** One speaker's open transcript row: fragments not yet closed by a gap. */
interface TurnBuffer {
  text: string;
  /** Session timeline, both ends. */
  startTimelineMs: number;
  endTimelineMs: number;
}

/** Everything whose lifetime is one provider dial. Created before the awaited dial (`socket`
 * stays null while it is in flight, which is what lets the mic path queue during the handshake)
 * and dropped whole when the dial fails, its socket closes, or the call is hung up. */
interface Dial {
  readonly conversationId: string;
  readonly activation: string;
  /** This dial's own identity, for keys that must not collide with an earlier dial of the same
   * call. */
  readonly dialId: string;
  /** The provider's socket, or null while the dial is in flight. */
  socket: WebSocket | null;
  /** True once `session.started` arrived and audio may flow. */
  ready: boolean;
  /** Facet clock when the provider's 101 came back. */
  socketReadyAtFacetMs: number;
  /** Capture held while the handshake completes, oldest first, and its decoded byte count. */
  micQueue: string[];
  micQueueBytes: number;
  /** Frames awaiting hand-over to the stream, oldest first: the delta's own base64, or an empty
   * frame carrying the end marker. Ordinarily one frame for the duration of one append. */
  speakerOutbox: { pcm: string; lastFrameOfAnswer?: true }[];
  /** Decoded PCM bytes presently queued; markers cost nothing. */
  speakerOutboxBytes: number;
  /** Once the outbox overflows, later deltas are ignored while the terminal is appended. */
  speakerOutboxOverflowed: boolean;
  /** One sender per live dial, started with its first output, waiting while the outbox is empty. */
  sending: boolean;
  /** Wakes the sender waiting on an empty outbox; null while it is sending or gone. */
  wakeSender: (() => void) | null;
  /** Facet clock at the last speaker frame handed over: the "this end is busy" reading the idle
   * deadline uses. */
  lastSpeakerFrameAtFacetMs: number;
  /** The next frame out tells the device to empty its speaker first. True from the moment the
   * dial is decided: the device may still hold frames from the incarnation that died. */
  clearSpeakerBufferBeforeNextFrame: boolean;
  /** The backend decided the call is over, with this reason; the call ends once the goodbye's end
   * marker has gone out (or the grace runs out). Runtime only: evicted, the idle deadline backstops. */
  hangUpReason: string | null;
  /** Facet clock when the hang-up was decided. */
  hangUpArmedAtFacetMs: number;
  /** An acknowledgement already playing at the decision is not the goodbye. */
  answerBeforeHangUp: Answer | null;
  /** The recap, including turns closed since the dial began. */
  transcript: TranscriptTurn[];
  /** The answer in flight. */
  answer: Answer;
  /** How far, on the facet clock, the device's forwarded audio reaches: each forwarded chunk
   * extends it by its own duration, so the silence fill covers only the gaps and never chops a
   * burst of speech. */
  micAudioCoveredUntilFacetMs: number;
  /** The furthest point on the provider's session timeline seen so far: transcript `end_ms` and
   * the running total of output audio. Output audio arrives every 100 ms whether or not anything
   * is said, so transcript rows close against it without any timer. */
  timelineMs: number;
  /** The two open transcript rows, one per speaker; both may be open at once. */
  turns: { user: TurnBuffer | null; assistant: TurnBuffer | null };
}

const freshDial = (conversationId: string, activation: string): Dial => ({
  conversationId,
  activation,
  dialId: crypto.randomUUID(),
  socket: null,
  ready: false,
  socketReadyAtFacetMs: 0,
  micQueue: [],
  micQueueBytes: 0,
  speakerOutbox: [],
  speakerOutboxBytes: 0,
  speakerOutboxOverflowed: false,
  sending: false,
  wakeSender: null,
  lastSpeakerFrameAtFacetMs: 0,
  clearSpeakerBufferBeforeNextFrame: true,
  hangUpReason: null,
  hangUpArmedAtFacetMs: 0,
  answerBeforeHangUp: null,
  transcript: [],
  answer: freshAnswer(),
  micAudioCoveredUntilFacetMs: 0,
  timelineMs: 0,
  turns: { user: null, assistant: null },
});

/** What the host injects; every wait and every clock in this file comes from here. */
export type VoiceAgentDeps = {
  projectContext?: () => Promise<string>;
  nowAtFacetMs(): number;
  /** The only way this processor waits, injected so tests can use a fake clock. */
  sleep(ms: number): Promise<void>;
  dialProvider(): Promise<WebSocket | null>;
};

type VoiceArgs = ProcessEventArgs<VoiceState, ConsumedEvent<VoiceAgentContract>>;

class VoiceAgentProcessor extends StreamProcessor<VoiceState, ConsumedEvent<VoiceAgentContract>> {
  readonly contract = VoiceAgentContract;

  constructor(private readonly deps: VoiceAgentDeps) {
    super();
  }

  /** The engine's `append` and fire-and-forget helper as handed over by the latest delivery.
   * Provider messages arrive outside any delivery and use these. */
  #append!: VoiceArgs["append"];
  #background!: VoiceArgs["runInBackground"];

  /** The dial this incarnation runs, or null. Created synchronously the moment a dial is decided,
   * so two deliveries cannot open two sockets, and null again when it fails, its socket closes or
   * the call is hung up. Every closure the dial spawns fences itself with `this.#dial !== dial`. */
  #dial: Dial | null = null;
  /** The fold's `lastDeviceInputAtStreamMs`, mirrored for the idle tick that runs between
   * deliveries and cannot read the fold. */
  #lastDeviceInputAtStreamMsMirror = 0;
  /** The activation whose terminal event is travelling through the log. */
  #endingActivation: string | null = null;

  reduce({ state, event }: ReduceArgs<VoiceState, ConsumedEvent<VoiceAgentContract>>) {
    const committedAtStreamMs = Date.parse(event.createdAt);
    switch (event.type) {
      case "events.iterate.com/voice-agent/call-started":
        /* Opening a call is the device's first input, so the deadline starts here. */
        if (state.call) return state;
        return {
          ...state,
          call: {
            conversationId: event.payload.conversationId,
            activation: event.payload.activation,
            lastDeviceInputAtStreamMs: committedAtStreamMs,
          },
        };

      case "events.iterate.com/voice-agent/mic-frame":
      case "events.iterate.com/voice-agent/keepalive":
        /* Their bodies never reach the fold, but their commit stamps are durable, and folding the
         * newest is what makes the idle deadline outlive an eviction. `max` so a redelivered batch
         * cannot walk it backwards. */
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
        return state.call?.activation === event.payload.activation
          ? {
              ...state,
              call: null,
              lastEnd: { activation: event.payload.activation, reason: event.payload.reason },
            }
          : state;

      case "events.iterate.com/voice-agent/utterance-transcript":
        if (event.payload.text === "") return state;
        return {
          ...state,
          transcript: foldTranscriptTurn(state.transcript, {
            role: "listener",
            text: event.payload.text,
          }),
        };

      case "events.iterate.com/voice-agent/answer-transcript":
        if (event.payload.text === "") return state;
        return {
          ...state,
          transcript: foldTranscriptTurn(state.transcript, {
            role: "assistant",
            text: event.payload.text,
          }),
        };

      default:
        return state;
    }
  }

  /** The engine publishes this after every batch — twenty microphone batches a second during a
   * call, so the runtime facts (dial ready, answer speaking) reach the page within a frame. */
  projectLiveState(state: VoiceState): VoiceLiveView {
    const dial = this.#dial;
    return {
      phase: state.call
        ? dial?.activation === state.call.activation && dial.ready
          ? "live"
          : "dialing"
        : state.lastEnd
          ? "ended"
          : "idle",
      activation: state.call?.activation ?? null,
      answering: Boolean(dial?.ready) && dial?.answer.phase === "speaking",
      transcript: state.transcript,
      lastEnd: state.lastEnd,
    };
  }

  processEvent(args: VoiceArgs): undefined {
    const { state, event, delivery } = args;
    this.#append = args.append;
    this.#background = args.runInBackground;
    if (state.call) this.#lastDeviceInputAtStreamMsMirror = state.call.lastDeviceInputAtStreamMs;

    /* The press put `call-started` in this facet's first batch, so dialling here overlaps the
     * provider handshake with the device's downlink bind and its first microphone frames. Only
     * the live event dials: a crash inside that batch re-delivers it and re-dials, which is right;
     * past its checkpoint the durable call without its event is the interruption recorded below. */
    if (
      event?.type === "events.iterate.com/voice-agent/call-started" &&
      state.call?.activation === event.payload.activation &&
      this.#dial === null
    ) {
      this.#openProviderConnection(state.call.conversationId, state.call.activation, state);
    }

    /* A provider session is volatile; its durable record cannot revive it. */
    const owedCall = delivery.caughtUp ? state.call : null;
    if (owedCall && this.#dial?.activation !== owedCall.activation) {
      args.blockProcessorWhile(() =>
        this.#end(owedCall.activation, "the voice session was interrupted"),
      );
    }

    if (event === null) return;

    switch (event.type) {
      case "events.iterate.com/voice-agent/thinking":
      case "events.iterate.com/voice-agent/commentary": {
        const dial = this.#dial;
        const update = event.payload;
        /* A dial dies with its incarnation; a redelivered update with no dial is not forwarded. */
        if (!dial || dial.activation !== update.activation) return;
        const sessionType =
          event.type === "events.iterate.com/voice-agent/thinking" ? "thinking" : "commentary";
        if (event.type === "events.iterate.com/voice-agent/commentary" && event.payload.hangUp) {
          dial.hangUpReason = "the Agent hung up";
          dial.hangUpArmedAtFacetMs = this.deps.nowAtFacetMs();
          dial.answerBeforeHangUp = dial.answer;
          this.#background(async () => {
            await this.deps.sleep(HANG_UP_GOODBYE_GRACE_MS);
            if (this.#dial !== dial || dial.answer.phase === "speaking") return;
            await this.#settleHangUp(dial);
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
        /* The frame stays the device's own base64 string all the way to the wire. */
        const micB64 = event.payload.pcm;
        /* An empty frame is a client bug, not audio: the provider rejects it. */
        if (micB64 === "") return;
        const dial = this.#dial;
        if (!dial || dial.activation !== event.payload.activation) return;
        const micBytes = base64ByteLength(micB64);
        if (dial.ready && dial.socket) {
          /* Capture duration is the only credit: anchoring frames to their arrival time would
           * count a slow transport gap as audio and keep the provider clock behind on every frame;
           * the silence fill covers the gaps instead. */
          dial.micAudioCoveredUntilFacetMs += micBytes / PCM16_BYTES_PER_MS;
          this.#sendMicAudio(dial.socket, micB64);
          return;
        }
        if (dial.micQueueBytes + micBytes <= MAX_HELD_MIC_BYTES) {
          dial.micQueue.push(micB64);
          dial.micQueueBytes += micBytes;
          return;
        }
        this.#hangUp();
        this.#background(() =>
          this.#end(
            dial.activation,
            `the provider did not become ready before ${MAX_HELD_MIC_BYTES / PCM16_BYTES_PER_MS}ms of microphone audio accumulated`,
          ),
        );
        return;
      }

      case "events.iterate.com/voice-agent/conversation-ended": {
        /* The device's own obituary (the hang-up button) reaches the dial only here; without this
         * arm a dead provider socket would squat `#dial` until the idle tick. */
        const dial = this.#dial;
        if (dial && dial.activation === event.payload.activation) {
          this.#flushTurns(dial, true);
          this.#hangUp();
        }
        return;
      }

      default:
        return;
    }
  }

  /** Open a provider connection for this call, now. */
  #openProviderConnection(
    conversationId: string,
    activation: string,
    state: VoiceArgs["state"],
  ): void {
    if (this.#dial !== null) return;
    /* Created before the awaited dial, so a second caller finds `#dial` taken and the mic path
     * queues for the whole handshake. */
    const dial = freshDial(conversationId, activation);
    dial.transcript = state.transcript;
    this.#dial = dial;
    const dialStartedAtFacetMs = this.deps.nowAtFacetMs();
    this.#background(async () => {
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
      );
    });
    this.#background(async () => {
      /* A dial can reject (DNS, TLS), not just refuse; both failures share one exit. */
      let socket: WebSocket | null = null;
      let failure = "the provider refused the connection";
      try {
        socket = await this.deps.dialProvider();
      } catch (error) {
        failure = `the provider dial failed: ${String(error).slice(0, 200)}`;
      }
      if (!socket) {
        if (this.#dial !== dial) return;
        this.#dial = null;
        await this.#end(activation, failure);
        return;
      }
      if (this.#dial !== dial) {
        /* Hung up while dialling: adopting the socket would resurrect a buried conversation. */
        try {
          socket.close();
        } catch {
          /* Already gone. */
        }
        return;
      }
      dial.socket = socket;
      dial.socketReadyAtFacetMs = this.deps.nowAtFacetMs();

      /* The provider's messages are handled here, not appended to the stream: ephemeral delivery
       * coalesces and would put a stream round trip in front of every word. */
      socket.addEventListener("message", (message: MessageEvent) => {
        /* A superseded socket is still a talking socket; the fence is the dial's identity. */
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
        this.#onLiveEvent(dial, live, type, receivedAtFacetMs, dialStartedAtFacetMs);
        /* Every message moves the session timeline, and a transcript row TURN_GAP_MS behind it
         * is a finished turn. */
        this.#flushTurns(dial, false);
      });

      socket.addEventListener("close", (event: CloseEvent) => {
        if (this.#dial !== dial) return;
        this.#dial = null;
        this.#flushTurns(dial, true);
        this.#providerClosed(
          conversationId,
          activation,
          `the provider's socket closed (${String(event.code)}${event.reason ? ` ${event.reason}` : ""})`,
        );
      });

      /* `session.start` is the first message, carrying the model, the audio format, the voice,
       * the policy and the seeded history; there is no `session.created` to wait for. */
      await this.#startSession(dial, state);
    });

    /* The idle countdown arms the moment the dial is decided, so a dial that never resolves is
     * still buried. A self-rescheduling tick chain rather than one long-lived closure, which the
     * facet keepalive's busy-refire detector would take for a wedge. */
    const idleTick = async (): Promise<void> => {
      await this.deps.sleep(5_000);
      if (this.#dial !== dial) return;
      const nowAtFacetMs = this.deps.nowAtFacetMs();
      /* Idle since the last thing that happened at either end: a listener hearing out a long
       * answer sends nothing, so this end's speaker frames count too. */
      const lastActivityAtFacetMs = Math.max(
        this.#lastDeviceInputAtStreamMsMirror,
        dial.lastSpeakerFrameAtFacetMs,
      );
      if (nowAtFacetMs - lastActivityAtFacetMs < IDLE_TIMEOUT_MS) {
        this.#background(idleTick);
        return;
      }
      await this.#end(activation, `no input from the device for ${IDLE_TIMEOUT_MS / 1000}s`);
    };
    this.#background(idleTick);
  }

  /** Start client delegation with the policy and the recap as history. */
  async #startSession(dial: Dial, state: VoiceArgs["state"]): Promise<void> {
    if (!dial.socket) return;
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
    dial.socket.send(
      JSON.stringify({
        type: "session.start",
        event_id: `start_${dial.dialId}`,
        session: {
          model: LIVE.model,
          instructions:
            LIVE_DELEGATION_POLICY +
            (this.deps.projectContext
              ? `\nCURRENT PROJECT: ${await this.deps.projectContext()}. Ingress refers to this project website.`
              : ""),
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
  ): void {
    const { conversationId } = dial;
    switch (type) {
      case "session.started": {
        /* Usable. Everything the handshake made us hold goes now. */
        dial.ready = true;
        const heldMicFrames = dial.micQueue.length;
        for (const held of dial.micQueue) this.#sendMicAudio(dial.socket!, held);
        dial.micQueue = [];
        dial.micQueueBytes = 0;
        dial.micAudioCoveredUntilFacetMs = receivedAtFacetMs;
        this.#startSilenceFill(dial);
        this.#background(() =>
          this.#append({
            type: "events.iterate.com/voice-agent/conversation-accepted",
            idempotencyKey: this.idempotencyKey(`accepted:${conversationId}:${dial.dialId}`),
            payload: {
              activation: dial.activation,
              conversationId,
              handshakeTookMs: receivedAtFacetMs - dialStartedAtFacetMs,
              upgradeTookMs: dial.socketReadyAtFacetMs - dialStartedAtFacetMs,
              heldMicFrames,
            },
          }),
        );
        return;
      }

      case "session.output_audio.delta": {
        if (typeof live.delta !== "string") return;
        this.#onOutputAudio(dial, live.delta, receivedAtFacetMs);
        return;
      }

      case "session.input_transcript.delta":
      case "session.output_transcript.delta": {
        if (typeof live.delta !== "string") return;
        const speaker = type === "session.input_transcript.delta" ? "user" : "assistant";
        const startTimelineMs = typeof live.start_ms === "number" ? live.start_ms : dial.timelineMs;
        const endTimelineMs = typeof live.end_ms === "number" ? live.end_ms : startTimelineMs;
        dial.timelineMs = Math.max(dial.timelineMs, endTimelineMs);
        const open = dial.turns[speaker];
        if (open && startTimelineMs - open.endTimelineMs >= TURN_GAP_MS) {
          /* A fragment landing well after the row's last: the row was a finished turn. */
          this.#closeTurn(dial, speaker);
        }
        const row = dial.turns[speaker];
        if (!row) {
          dial.turns[speaker] = { text: live.delta, startTimelineMs, endTimelineMs };
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
        this.#delegate(dial, parsed.data.delegation.id);
        return;
      }

      case "session.closed": {
        this.#flushTurns(dial, true);
        if (this.#dial === dial) this.#dial = null;
        this.#providerClosed(
          conversationId,
          dial.activation,
          `the provider closed the session (${String(live.reason ?? "unknown")})`,
        );
        return;
      }

      case "error":
        this.#background(() =>
          this.#append({
            type: "events.iterate.com/voice-agent/provider-error",
            payload: {
              conversationId,
              message: JSON.stringify(live.error ?? live).slice(0, 2_000),
            },
          }),
        );
        return;

      default:
        /* Acknowledgements and usage updates need no action. */
        return;
    }
  }

  /** One 100 ms delta of the provider's continuous output stream. The stream never stops, so
   * "is the voice speaking" is read off the audio: idle silence is dropped, speech opens an
   * answer and goes straight to the device, silence inside an answer rides along until the tail
   * bound ends the answer and `lastFrameOfAnswer` follows the last frame out. */
  #onOutputAudio(dial: Dial, delta: string, receivedAtFacetMs: number): void {
    const deltaMs = base64ByteLength(delta) / PCM16_BYTES_PER_MS;
    dial.timelineMs += deltaMs;
    /* Idle deltas are exact digital zero and speech onsets peak in the thousands. */
    const speaking = peakOfBase64Pcm16(delta) >= 100;

    if (dial.answer.phase === "settled") {
      if (!speaking) return;
      dial.answer = { phase: "speaking", trailingSilenceMs: 0 };
    } else if (speaking) {
      dial.answer.trailingSilenceMs = 0;
    } else {
      dial.answer.trailingSilenceMs += deltaMs;
      /* 700 ms of silence after speech ends the answer: the provider has no end-of-answer event
       * and pauses inside an answer are shorter. */
      if (dial.answer.trailingSilenceMs >= 700) {
        this.#endAnswer(dial, receivedAtFacetMs);
        return;
      }
    }

    /* The delta goes out as the base64 it arrived as; a larger delta than the device's frame
     * ceiling (no provider sends one today) is decoded and cut, because the device silently drops
     * an oversize frame. */
    if (base64ByteLength(delta) <= MAX_SPEAKER_PAYLOAD_BYTES) {
      this.#sendSpeakerFrame(dial, delta, receivedAtFacetMs);
      return;
    }
    const pcm16 = base64ToBytes(delta);
    for (let cut = 0; cut < pcm16.length; cut += MAX_SPEAKER_PAYLOAD_BYTES) {
      this.#sendSpeakerFrame(
        dial,
        bytesToBase64(pcm16.subarray(cut, Math.min(cut + MAX_SPEAKER_PAYLOAD_BYTES, pcm16.length))),
        receivedAtFacetMs,
      );
    }
  }

  #sendSpeakerFrame(dial: Dial, pcm: string, nowAtFacetMs: number): void {
    if (dial.speakerOutboxOverflowed) return;
    const pcmBytes = base64ByteLength(pcm);
    if (dial.speakerOutboxBytes + pcmBytes > SPEAKER_OUTBOX_MAX_BYTES) {
      dial.speakerOutboxOverflowed = true;
      this.#background(() =>
        this.#end(
          dial.activation,
          "the device speaker append stalled with more than ten seconds of queued audio",
        ),
      );
      return;
    }
    dial.lastSpeakerFrameAtFacetMs = nowAtFacetMs;
    dial.speakerOutbox.push({ pcm });
    dial.speakerOutboxBytes += pcmBytes;
    this.#startSpeakerSender(dial);
  }

  /** The answer ended: the marker goes out behind the last frame, and a hang-up armed before this
   * answer ended is now settleable. */
  #endAnswer(dial: Dial, nowAtFacetMs: number): void {
    const endedAnswer = dial.answer;
    dial.answer = freshAnswer();
    dial.speakerOutbox.push({ pcm: "", lastFrameOfAnswer: true });
    this.#startSpeakerSender(dial);
    if (
      dial.hangUpReason &&
      (endedAnswer !== dial.answerBeforeHangUp ||
        nowAtFacetMs - dial.hangUpArmedAtFacetMs >= HANG_UP_GOODBYE_GRACE_MS)
    ) {
      this.#background(async () => {
        /* The device prefills 400 ms and delivery adds a few hundred; a second preserves the
         * goodbye's tail. */
        await this.deps.sleep(1_000);
        await this.#settleHangUp(dial);
      });
    }
  }

  /** End the call the backend asked to end, unless the dial is already gone. Idempotent. */
  async #settleHangUp(dial: Dial): Promise<void> {
    if (this.#dial !== dial || !dial.hangUpReason) return;
    const reason = dial.hangUpReason;
    dial.hangUpReason = null;
    await this.#end(dial.activation, reason);
  }

  /** Send queued speaker frames in order for the lifetime of the dial, one frame per append (a
   * client push carries every event folded behind it, and the ESP32's inbox slot holds 16 KiB).
   * A rejected append ends the call: lost audio, a lost clear or a lost end marker cannot be
   * recovered by continuing with the next frame. */
  #startSpeakerSender(dial: Dial): void {
    if (dial.sending) {
      dial.wakeSender?.();
      return;
    }
    dial.sending = true;
    this.#background(async () => {
      try {
        while (this.#dial === dial) {
          const frame = dial.speakerOutbox.shift();
          if (!frame) {
            /* One background registration per dial: the sender waits for the next frame, and
             * the tick only notices a dial that ended. */
            await new Promise<void>((resolve) => {
              dial.wakeSender = resolve;
              void this.deps.sleep(1_000).then(resolve);
            });
            dial.wakeSender = null;
            continue;
          }
          dial.speakerOutboxBytes -= base64ByteLength(frame.pcm);
          const clearFirst = dial.clearSpeakerBufferBeforeNextFrame;
          dial.clearSpeakerBufferBeforeNextFrame = false;
          try {
            await this.#append({
              type: "events.iterate.com/voice-agent/spk-frame",
              /* The engine's append stamps provenance, not the catalog's ephemeral marker, and a
               * persisted frame is a row. */
              ephemeral: true,
              payload: {
                activation: dial.activation,
                conversationId: dial.conversationId,
                pcm: frame.pcm,
                ...(clearFirst && { clearSpeakerBufferBeforeFrame: true }),
                ...(frame.lastFrameOfAnswer && { lastFrameOfAnswer: true }),
              },
            });
          } catch {
            await this.#end(dial.activation, "the device speaker frame could not be appended");
            return;
          }
        }
      } finally {
        dial.sending = false;
        dial.wakeSender = null;
      }
    });
  }

  #flushTurns(dial: Dial, force: boolean): void {
    for (const speaker of ["user", "assistant"] as const) {
      const row = dial.turns[speaker];
      if (!row) continue;
      if (force || dial.timelineMs - row.endTimelineMs >= TURN_GAP_MS) {
        this.#closeTurn(dial, speaker);
      }
    }
  }

  /** One finished turn leaves one durable event carrying its words, keyed on the dial and the
   * row's start so a redelivered close cannot write a turn twice. */
  #closeTurn(dial: Dial, speaker: "user" | "assistant"): void {
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
    this.#background(() =>
      speaker === "user"
        ? this.#append({
            type: "events.iterate.com/voice-agent/utterance-transcript",
            idempotencyKey: this.idempotencyKey(key),
            payload: { conversationId: dial.conversationId, text, key: transcriptKey },
          })
        : this.#append({
            type: "events.iterate.com/voice-agent/answer-transcript",
            idempotencyKey: this.idempotencyKey(key),
            payload: { conversationId: dial.conversationId, text, key: transcriptKey },
          }),
    );
  }

  #startSilenceFill(dial: Dial): void {
    this.#background(async () => {
      while (this.#dial === dial && dial.socket && dial.ready) {
        await this.deps.sleep(SILENCE_FILL_MS);
        if (this.#dial !== dial || !dial.socket || !dial.ready) return;
        /* Paced to the wall clock, never to the loop: a sleep that wakes late still owes the
         * provider every millisecond since the device was last heard. Device audio moves the
         * stamp itself, so the fill covers only the gaps. */
        const nowAtFacetMs = this.deps.nowAtFacetMs();
        let owedMs = nowAtFacetMs - dial.micAudioCoveredUntilFacetMs;
        /* A second of debt is scheduling jitter; more leaves the provider's input timeline
         * untrustworthy, so the call ends with a reason rather than bursting synthetic input
         * ahead of a person who has started speaking again. */
        if (owedMs > 1_000) {
          await this.#end(dial.activation, `the provider input clock fell ${owedMs}ms behind`);
          return;
        }
        while (owedMs >= SILENCE_FILL_MS) {
          dial.micAudioCoveredUntilFacetMs += SILENCE_FILL_MS;
          owedMs -= SILENCE_FILL_MS;
          this.#sendMicAudio(dial.socket, SILENCE_FILL_FRAME_B64);
        }
      }
    });
  }

  #sendMicAudio(socket: WebSocket, b64: string): void {
    const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    socket.send(JSON.stringify({ type: "session.input_audio.append", audio: padded }));
  }

  /** A provider close ends the uncertain session; it is never replayed. */
  #providerClosed(conversationId: string, activation: string, reason: string): void {
    if (this.#endingActivation === activation) return;
    this.#background(async () => {
      await this.#end(activation, reason);
      await this.#append({
        type: "events.iterate.com/voice-agent/provider-disconnected",
        payload: { conversationId, reason },
      });
    });
  }

  async #end(activation: string, reason: string): Promise<void> {
    if (this.#endingActivation === activation) return;
    this.#endingActivation = activation;
    const dial = this.#dial;
    if (dial?.activation === activation) {
      this.#flushTurns(dial, true);
      this.#hangUp();
    }
    try {
      await this.#append({
        type: "events.iterate.com/voice-agent/conversation-ended",
        idempotencyKey: this.idempotencyKey(`ended:${activation}`),
        payload: { activation, reason },
      });
    } catch (error) {
      if (this.#endingActivation === activation) this.#endingActivation = null;
      throw error;
    }
  }

  /** The live model handed a request to the backend: emit `delegation-requested` with the words
   * said so far (the agent facet on this context answers it with `commentary`) and tell the voice
   * it may keep talking. */
  #delegate(dial: Dial, delegationId: string): void {
    const transcript = this.#delegationTranscript(dial);
    this.#background(async () => {
      try {
        await this.#append({
          type: "events.iterate.com/voice-agent/delegation-requested",
          idempotencyKey: this.idempotencyKey(`delegation:${dial.dialId}:${delegationId}`),
          payload: {
            activation: dial.activation,
            conversationId: dial.conversationId,
            delegationId,
            transcript,
          },
        });
        if (this.#dial === dial) {
          this.#sendControl(dial, {
            type: "session.thinking.append",
            delegation_id: delegationId,
            content: "The request was handed to the backend; the conversation may continue.",
          });
        }
      } catch (error) {
        if (this.#dial !== dial) return;
        await this.#end(
          dial.activation,
          `the delegation could not be recorded: ${String(error).slice(0, 200)}`,
        );
      }
    });
  }

  /** The words so far: the recap (closed turns) and both open rows. */
  #delegationTranscript(dial: Dial): TranscriptTurn[] {
    const open = (["user", "assistant"] as const).flatMap((speaker) => {
      const row = dial.turns[speaker];
      const text = row?.text.replace(/\s+/g, " ").trim() ?? "";
      if (!row || text === "") return [];
      return [{ role: speaker === "user" ? ("listener" as const) : ("assistant" as const), text }];
    });
    return [...dial.transcript, ...open];
  }

  #sendControl(dial: Dial, message: Record<string, unknown>): void {
    if (!dial.socket) return;
    dial.socket.send(JSON.stringify(message));
  }

  /** Let the dial and everything hanging off it go. Safe to call twice. The provider is asked to
   * close first (`session.close` is what makes it finalize usage) and the socket is closed behind
   * it without waiting. */
  #hangUp(): void {
    const dial = this.#dial;
    this.#dial = null;
    try {
      if (dial?.ready && dial.socket) {
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

/** Open the provider's WebSocket. No query parameters (the model rides `session.start`), and the
 * bearer is the platform's `getSecret` grammar, substituted at egress so the key never enters this
 * isolate. */
async function dialProviderSocket(): Promise<WebSocket | null> {
  const response = await fetch(LIVE.url, {
    headers: { Upgrade: "websocket", Authorization: 'Bearer getSecret("/secrets/openai")' },
  });
  const socket = response.webSocket || null;
  if (!socket) return null;
  socket.binaryType = "arraybuffer"; // before accept(): the current default is Blob
  socket.accept();
  return socket;
}

/** The class the loader hosts: `facets.get("voice-agent", { source, className: "VoiceAgentDurableObject" })`. */
export class VoiceAgentDurableObject extends StreamProcessorDurableObject<VoiceState> {
  processor = new VoiceAgentProcessor({
    nowAtFacetMs: () => Date.now(),
    /* A bare setTimeout is safe because every wait happens inside a background closure the host
     * keeps alive. */
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    dialProvider: dialProviderSocket,
    projectContext: async () => JSON.stringify(await this.withItx((itx) => itx.whoami())),
  });
}
