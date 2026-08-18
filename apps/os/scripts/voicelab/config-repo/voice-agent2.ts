/**
 * The voice agent, second cut: one fold, one reaction, and a sequence number on
 * every frame that says which lane it belongs to.
 *
 * WHY A REWRITE RATHER THAN AN EDIT.
 *
 * The first cut grew a class per concern — a call object, a speaker module, a
 * viseme tracker, event factories — and the concerns then had to agree with
 * each other. They stopped agreeing in one specific place, and it is the bug
 * this file exists to make unrepresentable:
 *
 *   `drop` WAS A BOOLEAN. "Discard whatever you are holding" names no audio, so
 *   a second one arriving late discards the answer that replaced the one it
 *   meant. Grok's `input_audio_buffer.speech_started` is a TENTATIVE VAD onset
 *   — it fires on any voice-shaped energy, including a board's own echo
 *   residue, and retracts itself without ceremony — and the first cut made
 *   every one of them destructive. Five per turn were measured on the board's
 *   own counter. What you hear is an assistant that counts to four, stops,
 *   counts to nine, stops.
 *
 *   HERE A FLUSH NAMES A SEQUENCE NUMBER. "Every speaker frame up to and
 *   including 47 is dead." Repeat it and it is a no-op; deliver it late and it
 *   cannot touch frame 48, because 48 was minted after the decision was taken.
 *   The same five VAD blips cost one flush and four no-ops. Idempotence by
 *   construction, not by care.
 *
 *   AND THE FLUSH IS ONLY THE DEVICE'S. The facet's own queue — up to ~36 s
 *   of a burst answer the pacer has not handed over yet — survives a
 *   tentative onset: the device is silenced at once, the pacer pauses, and
 *   the queue waits for the onset to commit or retract (see the
 *   speech_started arm). Emptying it on every blip was the counting bug in a
 *   second form: the flush cost one stutter, the emptied queue cost the
 *   whole unsent tail.
 *
 * TWO SEQUENCES, AND THEY ARE NOT INTERCHANGEABLE. Every count in this file
 * says which of the two it belongs to, because conflating them is how the
 * first cut lost track of what a flush was flushing:
 *
 *   `deviceMicFrameSeq`      device microphone -> facet -> Grok. Minted by the
 *                            DEVICE; the facet never renumbers it.
 *   `deviceSpeakerFrameSeq`  facet -> device speaker. One per paced chunk. A
 *                            single provider delta usually becomes several of
 *                            these — which is exactly why a flush must name
 *                            this one and no other. (There was a third count
 *                            once, per received provider delta, riding every
 *                            frame as `fromProviderDeltaSeq` — "debugging, not
 *                            ordering" by its own docstring, read by no device
 *                            and no instrument; the grok-event lane's
 *                            `deltaBytes` keeps the coarse correlation.)
 *
 * EVERY TIMESTAMP SAYS WHERE IT WAS TAKEN, in its name, with no exceptions.
 * FOUR CLOCKS, and this is the whole taxonomy — anything measuring this system
 * uses these four names and coins no fifth:
 *
 *   `...AtDeviceMs`   THE CLIENT that holds the microphone: a board's uptime,
 *                     or a laptop running the host CLI or a latency probe. Not
 *                     wall time on a board, and not the same clock twice if
 *                     there are two clients.
 *   `...AtFacetMs`    read inside this processor, `deps.nowAtFacetMs()`
 *   `...AtStreamMs`   the Stream Durable Object's commit stamp (`event.createdAt`)
 *   `...AtProviderMs`     a stamp the PROVIDER put on its own event
 *
 * None of them is synchronised with any other. A duration is only meaningful
 * between two stamps with the SAME suffix; subtracting across them is the
 * mistake that produced a device muting itself against a deadline from
 * somebody else's clock, and a latency probe reporting minus fifty-nine
 * seconds because one end of the subtraction was `Date.now()` and the other
 * was `performance.now()` — two clocks on ONE machine, which is why "it is all
 * local" is not a defence.
 *
 * A duration therefore has no `At`: it is `...Ms`, it belongs to no clock, and
 * it is the ONLY thing safe to send across a boundary. That is how an
 * instrument on a laptop attributes a turn it measured itself to work done on
 * a facet whose clock it has never seen: it subtracts facet-clock durations
 * read off the `grok-event` lane's own stamps.
 *
 * THE CLIENT IS DUMB, AND THAT IS THE DESIGN, NOT A LIMITATION.
 *
 * An ESP32 has a few hundred kilobytes of RAM, one core to spare, and no idea
 * what a conversation is. So it is given no decisions to make. Its entire
 * contract is three sentences:
 *
 *   1. Send microphone frames up, numbered, forever. It does not decide when a
 *      turn starts or ends, whether anyone is talking over anyone, or whether
 *      it should be listening. Turn taking is Grok's job and the server's; the
 *      board that tried to help is the board that muted itself.
 *   2. Play speaker frames in `deviceSpeakerFrameSeq` order.
 *   3. If a frame says `clearSpeakerBufferBeforeFrame`, throw away everything
 *      queued before playing it.
 *
 * THE SERVER PACES TO THE DEVICE'S BUFFER, rather than sending as fast as it
 * can and hoping. Grok hands over a forty-second answer in a few seconds; a
 * board given that at wire speed drops most of it on the floor and conceals the
 * shortfall as clipped words — measured at 9-31 frames a second against the 50
 * realtime needs. So the drain loop below hands over at most
 * `MAX_DEVICE_SPEAKER_BACKLOG_BYTES` and then sends at exactly the rate
 * the audio plays, so the backlog cannot grow past that budget.
 *
 * THAT IS A MODEL OF MEMORY ON ANOTHER MACHINE, and the honest thing is to say
 * so rather than dress it up. A budget denominated in the device's RAM cannot
 * be expressed without one. It carries an error term nobody can measure — the
 * lag between handing a frame to the stream and the board starting to play it
 * — and it is paid for by keeping the budget well under the firmware's own
 * ceiling, where the margin cannot be spent by tuning. What it buys is that the
 * device is never asked how it is doing: a server that needs the client to
 * report is a server that stalls when the client goes quiet, and half the fleet
 * says nothing at all while it is listening to an answer.
 *
 * AND THE CLEAR RIDES ON A FRAME. It was a separate event once, on a second
 * lane, where it could arrive behind the audio it invalidates. Attached to a
 * numbered frame it cannot: the frame carrying the clear has a higher sequence
 * number than everything it cancels, so a device that orders by sequence number
 * gets the right answer even out of order. An interruption with no audio behind
 * it is an EMPTY frame carrying the flag — still a frame, still numbered, still
 * ordered.
 *
 * THE SHAPE:
 *
 *   REDUCED STATE is what survives an eviction: which call is up, how far the
 *   speaker clear has reached, when the device was last heard from.
 *
 *   RUNTIME STATE is the provider socket plus two frame queues, and nothing
 *   else that a restart would miss.
 *
 *   TWO SWITCHES. `reduce` folds, `processEvent` acts. There is a third inside
 *   the provider socket's message listener, and its comment says why it cannot
 *   be a stream event like everything else.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: no visemes, no head gestures, no tool
 * calling. Those are real features of the first cut and belong in their own
 * files, wired to the same events. This one runs a call. (There was a
 * `turn-timing` lane here once — four per-turn stamps for the latency
 * campaign; that campaign concluded and the subsystem was deleted whole
 * rather than half-moved. `grok-event` still carries every provider stamp an
 * instrument needs, minus the mic-frame gap histogram, which did not survive.)
 */
import {
  IterateWorkerEntrypoint,
  StreamProcessorFacet,
  type ProcessorHostDeps,
  type StatefulDynamicWorkerRef,
} from "iterate/sdk";
import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import {
  defineProcessorContract,
  StreamProcessor,
  type ProcessEventArgs,
  type ReduceArgs,
} from "iterate/processors";
import { z } from "zod";
import { Pcm16Resampler } from "./pcm.ts";

/* ========================================================================== */
/* CONSTANTS                                                                  */
/* ========================================================================== */

const XAI_SECRET = "/secrets/xai";
const OPENAI_SECRET = "/secrets/openai";

/** A realtime voice provider this agent can dial. */
export type VoiceProvider = "grok" | "openai";

/**
 * EVERYTHING PROVIDER-SPECIFIC, IN ONE TABLE. Grok's realtime API is a
 * deliberate clone of OpenAI's GA interface — same handshake, same event
 * names, same session.update shape — so the abstraction the birth
 * certificate selects is not an adapter layer, it is four values: where to
 * dial, which model, which voice, and the ONE real difference, the PCM rate.
 * OpenAI speaks 24 kHz where this whole pipeline is 16; the two resample
 * sites below are the entire cost of supporting it.
 */
const PROVIDERS: Record<
  VoiceProvider,
  { url: string; model: string; voice: string; rate: number }
> = {
  grok: {
    url: "https://api.x.ai/v1/realtime",
    model: "grok-voice-think-fast-2.0",
    voice: "eve",
    rate: 16_000,
  },
  openai: {
    url: "https://api.openai.com/v1/realtime",
    /* The bare `gpt-realtime` alias stays on the ORIGINAL 2025 GA family
     * for ever; the successors ship under new names. Proven through the
     * barge/truncate/note gauntlet 2026-08-18 before becoming the default. */
    model: "gpt-realtime-2.1",
    voice: "marin",
    rate: 24_000,
  },
};

/**
 * Grok's own default threshold, restored.
 *
 * It was lowered to 0.4 to make barge-in feel quick, at a time when every
 * detection destroyed the speaker queue — so the two changes together turned
 * echo residue into a stutter. With a flush that names a sequence number a
 * false onset is cheap, so the threshold no longer has to buy responsiveness by
 * being wrong more often. `prefix_padding_ms` keeps the audio just BEFORE the
 * detector fired, so the first consonant of an interruption survives.
 */
const SERVER_VAD = { type: "server_vad", threshold: 0.85, prefix_padding_ms: 333 } as const;

/**
 * The most unplayed audio the device may be holding, in wire bytes.
 *
 * WIRE BYTES ARE RING BYTES NOW, which is the one good thing about dropping
 * mu-law here. The device used to expand every byte on receipt, so one wire
 * byte became two in its ring and a budget written against the ring without
 * halving was a 2x error in a safety margin. PCM16 on the wire is PCM16 in the
 * ring and the two numbers are finally the same number.
 *
 * DERIVED FROM THE FIRMWARE, NOT CHOSEN. The ring is 320,000 bytes of PCM16 in
 * PSRAM (voice_device_profile.h), and the device skips frames once its backlog
 * passes ITERATE_KIT_VOICE_SPEAKER_HIGH_WATER_MS (9,000 ms) — a ceiling of
 * 288,000 bytes. 128,000 is four seconds, exactly forty frames, and 40% of the
 * ring. The remaining 60% pays for three things no instrument on either side
 * can measure: the lag between handing a frame to the stream and the device
 * starting to play it, a playback clock running slow, and a revived
 * incarnation bursting a budget on top of one the dead incarnation already
 * sent.
 *
 * OVERFLOWING IS SILENT, WHICH IS WHY THE MARGIN IS LARGE. The device refuses
 * whole frames at the door and its loss counters stay innocent — a 1.5 s ring
 * was measured hiding 2,080 discarded frames, 41 seconds of speech, across two
 * minutes of ordinary conversation. A gap in speech complains; this does not.
 *
 * COUPLED TO MAX_SPEAKER_PAYLOAD_BYTES, which is a separate ceiling on a
 * single message rather than on the backlog, and much the smaller of the two.
 */
export const MAX_DEVICE_SPEAKER_BACKLOG_BYTES = 128_000;

/**
 * The most audio one speaker frame may carry, in bytes.
 *
 * A CEILING, NOT A UNIT. Frames are whatever length the audio happens to be,
 * up to this; the device appends the bytes to its speaker ring and neither end
 * cares where one frame stops and the next starts. What survives here is only
 * the device's receive path: a chunk over ITERATE_KIT_VOICELAB_CHUNK_BYTES
 * (4,800), or a base64 encoding of it over ITERATE_KIT_VOICELAB_B64_CAPACITY
 * (6,912) inside an envelope capped at ITERATE_KIT_VOICELAB_ARGS_CAPACITY
 * (7,600), is dropped at the door without a word. 3,200 is 100 ms, encodes to
 * 4,268 characters, and leaves the margin unspent.
 *
 * WHAT THIS REPLACED was a 640-byte alignment rule, and the difference is the
 * whole point. The board used to be handed exactly one 20 ms frame at a time,
 * so a chunk with anything left over on the end was a protocol violation it
 * counted and threw away — which every Grok delta had, none of them being a
 * multiple of 640. Cutting each delta independently cost 118 dropped chunks in
 * three turns, and buying that back needed a carried remainder between deltas
 * and a silence-padded tail at the end of each answer. The ring on the device
 * never needed any of it: it takes bytes.
 */
export const MAX_SPEAKER_PAYLOAD_BYTES = 3_200;

/** 16 kHz mono PCM16: two bytes per sample, sixteen samples per millisecond. */
const PCM16_BYTES_PER_MS = 32;

/** No input from the device for this long and the call is over. */
const IDLE_TIMEOUT_MS = 60_000;

/**
 * The idle stamp advances in steps of this, not per frame.
 *
 * Folding every mic frame's commit stamp made EVERY delivery batch dirty the
 * reduced state, and the runner durably commits dirtied state once per batch,
 * inside the delivery acknowledgement — an output-gated storage write per
 * 240 ms of audio, paid before the next batch may dispatch. The deadline this
 * stamp feeds is sixty seconds; knowing the device's last input to five is
 * every bit as good, and it makes the fold a no-op for ~95% of mic batches —
 * which is what lets the runner skip the commit entirely once it learns to.
 */
const IDLE_STAMP_STEP_MS = 5_000;

/** How often the idle countdown looks at the facet clock. */
const IDLE_TICK_MS = 5_000;

/**
 * A tool that hangs must still be answered: the model hears "took too long"
 * and says so, instead of the silence a lost debt produces — a voice model
 * waiting on a tool output is a dropped call as far as the listener can tell.
 */
const TOOL_RUN_DEADLINE_MS = 10_000;

/**
 * A tool result lives in the model's context for the rest of the call, and
 * nobody budgeted the session for a table dump.
 */
const TOOL_OUTPUT_MAX_CHARS = 4_000;

/**
 * How many microphone frames may be held while Grok completes its handshake.
 *
 * Bounded because a handshake that never finishes must not grow a queue without
 * limit. The NEWEST frames are refused once it is full, not the oldest: the
 * start of what somebody said is what makes the rest of it intelligible, and a
 * handshake this slow has already lost the turn either way.
 */
const MAX_HELD_MIC_FRAMES = 500;

/*
 * WHO TAKES THE TURNS was a hardcoded list of board names, and it is now a
 * setting on the stream that defaults to Grok.
 *
 * The list held all three boards this lab owns, which is the tell: "the
 * microphone rides the call open and server VAD segments it" was never the
 * exception, it was every client, and push-to-talk is the special case. As a
 * list it also failed in the worst available way — a client whose name was not
 * in it got `turn_detection: null`, so Grok waited for a commit that an
 * open-mic client never sends, and the call sat there perfectly healthy and
 * completely silent with nothing logged anywhere. That cost a full unattended
 * run against real Grok to find, and the fix is not a longer list: it is that
 * the question has an answer the client knows and the server cannot guess.
 *
 * See `clientTakesTurns` on the birth certificate.
 */

/* ========================================================================== */
/* AUDIO                                                                      */
/* ========================================================================== */
/* Base64 is handled here; RATE CONVERSION is not — see pcm.ts, which holds
 * the one real transcode in this pipeline and the story of why its linear
 * predecessor was the audible difference between OpenAI here and OpenAI's
 * own app. */

/**
 * PCM16 to G.711 mu-law.
 *
 * Halving the bytes is what lets a microcontroller receive speech at all: the
 * board was measured taking 9-31 frames a second against the 50 that realtime
 * needs, and concealing the shortfall as clipped words.
 */
/*
 * THE TWO MU-LAW CODECS WERE HERE, AND WHY THEY MIGHT COME BACK.
 *
 * One codec on the wire instead of two. The pair of them cost this file two
 * entirely silent calls against the real provider — the device sent mu-law,
 * this end read it as PCM16, and Grok heard broadband noise at half the
 * intended duration, found no speech, and answered nothing. No error anywhere.
 * A transcode that both ends have to agree about is a thing both ends can be
 * wrong about, and the unit tests could not help because the fake device in
 * them was written by whoever was already confused.
 *
 * What it bought was real and is not visible from here: on an ESP32 over
 * Wi-Fi, base64 PCM16 once stalled the TCP flow outright, and the downlink
 * delivered 9-31 frames a second against the 50 that realtime needs. Both
 * numbers were measured on boards, and no run from a Mac on a wired network
 * can reproduce either. If a board goes quiet or starts concealing, this is
 * the first thing to put back; `git log` has both functions intact.
 */

/** Bytes to base64, chunked so a long answer cannot blow the argument list. */
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
 * One tool the model may call, as data on the birth certificate.
 *
 * `expression` is a walk from the PROJECT ROOT to a function; the model's
 * parsed arguments object is that function's single argument. Persisting an
 * expression persists the NAME of a capability, never its authority — every
 * call re-derives authority from a fresh project session. A tool with NO
 * expression is a name this agent already knows how to be: `hang_up` is the
 * only one, and it is one atomic append of conversation-end-requested, no
 * itx involved. The base case, not a registry — the way "grok" is one row
 * of PROVIDERS rather than a Provider subclass.
 */
const VoiceTool = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    /** What the provider shows the model; usage guidance lives here, not in
     * `instructions` — "say goodbye BEFORE calling this" rides the tool. */
    description: z.string(),
    /** JSON Schema for the arguments, handed to the provider verbatim.
     * Absent means a no-argument tool. */
    parameters: z.looseObject({}).optional(),
    expression: z.array(ItxExpressionStep).min(1).optional(),
  })
  .refine((tool) => tool.expression !== undefined || tool.name === "hang_up", {
    message: 'a tool with no expression must be a name this agent knows; today that is "hang_up"',
  });

/**
 * Everything that outlives the Durable Object holding the socket.
 *
 * Note what is NOT here: no queues, no byte counts, no "is speaking" flag.
 * Reduced state that depends on a buffer no restart can replay is a lie, and
 * every derived number kept beside its source is a chance for the two to
 * disagree.
 */
const VoiceState = z.object({
  /** Dial this instead of x.ai. Test seam; carries no credential. */
  providerBaseUrl: z.string().nullable().default(null),
  /** Which realtime voice provider this stream's calls dial. */
  provider: z.enum(["grok", "openai"]).default("grok"),
  /** Model and voice overrides; null takes the provider's default. */
  providerModel: z.string().nullable().default(null),
  providerVoice: z.string().nullable().default(null),
  /** What the model is told it is. Empty means Grok's own default. */
  instructions: z.string().default(""),
  /**
   * The call, as an obligation rather than a closure.
   *
   * A socket dies with its incarnation; this does not. `call-started` opens it,
   * `conversation-ended` closes it, and the caught-up pass re-dials anything
   * still open — which is what makes an eviction mid-call recoverable without
   * anyone having to notice it happened.
   */
  /**
   * The client segments its own turns with the push-to-talk verbs.
   *
   * FALSE MEANS GROK LISTENS, which is the right default: every board this lab
   * has holds its microphone open for the whole call, and full duplex with
   * server-side VAD is the behaviour being built towards. A client that really
   * does own its turns — a terminal where somebody holds the space bar — says
   * so at setup, and then `ptt-end` is what commits the buffer.
   *
   * On the stream rather than on the call because it is a fact about the
   * client that outlives any one conversation, and because a call opened by
   * the recovery path has no event to read it from.
   */
  clientTakesTurns: z.boolean().default(false),
  /** Tools the model may call — see {@link VoiceTool}. */
  tools: z.array(VoiceTool).default([]),
  call: z
    .object({
      conversationId: z.string(),
      /**
       * When the Stream DO committed the device's most recent input — a mic
       * frame or a button edge.
       *
       * THE DEVICE'S INPUT, not "the last thing anybody said": the agent's own
       * speech leaves no durable event, so this cannot see it and must not
       * claim to. It is the floor under the idle deadline, and it is on the
       * STREAM clock because that is the only clock every incarnation shares.
       */
      lastDeviceInputAtStreamMs: z.number(),
      /** Decided, not yet done: nothing re-dials a call with this set. */
      endRequested: z.strictObject({ reason: z.string() }).nullable(),
    })
    .nullable()
    .default(null),
});

const EPH = { ephemeral: true as const };

export const VoiceAgent2Contract = defineProcessorContract({
  /* THE SAME SLUG AS THE FIRST CUT, because the slug IS the contract selector:
   * the live subscription is named for it, and the device speaks these event
   * names already. A new slug would have meant re-provisioning every board to
   * say the same three verbs down a differently-named pipe. */
  slug: "voice-agent",
  /* 3.0.0: the fold is renamed and extended almost throughout —
   * `birthCertificate: { providerBaseUrl }` flattened, `lastHeardAtMs` renamed
   * now that it says whose input it records and on which clock, plus a client
   * on the call and a flush watermark under it. The watermark is the first
   * durable speaker state this processor has ever had; the first cut's speaker
   * lived entirely in memory and died with every incarnation, which is why a
   * revived one could replay an answer the listener had already talked over.
   * A persisted 2.x fold is missing or misnaming most of this, so bumping the
   * major is how the runner is told to re-reduce rather than load it. */
  /* 4.0.0: the provider abstraction finished what it started — the fold's
   * `grokBaseUrl`/`grokInstructions` became `providerBaseUrl`/`instructions`
   * and the speaker frame's `fromGrokAudioDeltaSeq` became
   * `fromProviderDeltaSeq`, because half the streams this serves no longer
   * dial Grok. A persisted 3.x fold misnames those; the major bump re-reduces
   * instead of loading it. Clean break, no aliases. */
  /* 5.0.0: the birth certificate carries `tools` — itx expressions the model
   * may call, plus the well-known hang_up. Clean break like every bump before
   * it: the major re-reduces any persisted older fold. */
  /* 6.0.0: the mutable birth certificate splits. `created` becomes
   * existence-only under a stable per-stream key — a second birth is
   * corruption, not an update — and the whole provider configuration moves to
   * a new `configured` event under the content-hash+setupId key `created`
   * used to wear. Config-after-birth is an ordinary event now, which is what
   * the explicit-birth doctrine always said it was. The major re-reduces any
   * persisted older fold; old streams re-fold their historical `created`
   * payloads into nothing (existence) and are reconfigured by the next
   * setup run. */
  version: "6.0.0",
  description: "Runs a voice call in the stream's own Durable Object, one flush watermark deep.",
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
        "The agent's whole provider configuration, REPLACED WHOLESALE: an absent field means " +
        "its default, never 'keep the old value'. Appended by every setup run whose content " +
        "differs.",
      payloadSchema: z.strictObject({
        providerBaseUrl: z.string().optional(),
        provider: z.enum(["grok", "openai"]).optional(),
        providerModel: z.string().optional(),
        providerVoice: z.string().optional(),
        instructions: z.string().optional(),
        clientTakesTurns: z.boolean().optional(),
        tools: z.array(VoiceTool).optional(),
      }),
    },
    /*
     * THE DEVICE'S HALF, and it is three verbs: the button went down, here is
     * audio, the button came up. Whether a call exists, what it is called and
     * when it ends are the server's, because the server is the only side that
     * can know them.
     */
    "events.iterate.com/voice-agent/ptt-start": {
      description: "The user began speaking. Opens a call if one is not already up.",
      ...EPH,
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/voice-agent/mic-frame": {
      description: "One capture frame, numbered by the device that captured it.",
      ...EPH,
      payloadSchema: z.looseObject({
        /** 16 kHz mono PCM16, base64. The only encoding this lane carries.
         * The loose object is deliberate: devices decorate frames with their
         * own counters and clocks, and the facet reads none of it. */
        pcm: z.string(),
      }),
    },
    "events.iterate.com/voice-agent/ptt-end": {
      description: "The user stopped speaking; the turn is complete.",
      ...EPH,
      payloadSchema: z.looseObject({}),
    },
    /* There was briefly a `keepalive` event here — a client-appended no-op
     * whose delivery reset the stream's five-second idle teardown, because
     * the teardown fired in every between-turn gap and charged its
     * resurrection to every press. It measured what it needed to measure
     * (uplink lateness p90 188ms -> 38ms) and then died: the platform now
     * holds delivery lanes open on its own while a facet has work in flight,
     * which it can see from the facet keepalive's alarm desire. A contract
     * should never need to say "I am still here" — the platform knows. */

    "events.iterate.com/voice-agent/call-started": {
      description: "The server opened a call and what it is called.",
      payloadSchema: z.looseObject({
        conversationId: z.string(),
      }),
    },
    "events.iterate.com/voice-agent/conversation-accepted": {
      description: "Grok accepted the session; the call is live.",
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
      description: "Grok reported an error, verbatim.",
      payloadSchema: z.looseObject({ conversationId: z.string(), message: z.string() }),
    },

    /*
     * THE SPEAKER LANE. Two events, and between them the device's entire buffer
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
        /**
         * 16 kHz mono PCM16, base64, of no particular length — the device
         * appends it to a byte ring. EMPTY on a frame whose only job is the
         * clear.
         *
         * THERE IS NO CODEC FIELD BESIDE IT, and there was one until the lane
         * carried a second codec's worth of nothing: `enc` was written by both
         * ends, read by neither on this track, and branched on by exactly one
         * line in v1 against a value the firmware had stopped sending. A
         * negotiation field for a protocol with one encoding is a conditional
         * waiting to take the wrong arm.
         */
        pcm: z.string(),
        /**
         * Throw away everything queued, then play this frame.
         *
         * Named for what the device DOES, because the device is dumb by design
         * and its whole buffer policy should be readable off the payload. It
         * was `drop: true` once, which named no audio — so a late one discarded
         * the answer that replaced the one it meant. Bound to a numbered frame
         * it cannot: it clears what precedes THIS sequence number and nothing
         * else.
         */
        clearSpeakerBufferBeforeFrame: z.boolean().optional(),
        /**
         * Nothing more is coming for this answer; what you hold is all of it.
         *
         * The device needs this and cannot infer it: silence on the wire looks
         * identical to a slow provider, so without it a client waits for a tail
         * that will never arrive and never closes the turn. It rides a NUMBERED
         * frame and is raised only once the queue behind it is empty, which is
         * what makes it safe — the old `last` had to be attached to whichever
         * frame turned out to be final, and an answer shorter than the head
         * start had already been sent by the time the provider said it was
         * over, so there was nothing left to attach it to and the flag was
         * simply lost. Here the marker is its own frame when it has to be.
         */
        lastFrameOfAnswer: z.boolean().optional(),
        /** Facet clock, at the moment this frame was handed to the stream. */
        sentAtFacetMs: z.number(),
      }),
    },
    "events.iterate.com/voice-agent/grok-event": {
      description:
        "Grok's own events for instruments — verbatim, except an audio delta's bytes become `deltaBytes`.",
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
    /* The live half. Naming them is the whole opt-in — `"*"` never matches an
     * ephemeral event, so nobody gets this firehose by accident. */
    "events.iterate.com/voice-agent/ptt-start",
    "events.iterate.com/voice-agent/mic-frame",
    "events.iterate.com/voice-agent/ptt-end",
  ],
  emits: [
    "events.iterate.com/voice-agent/call-started",
    "events.iterate.com/voice-agent/conversation-accepted",
    "events.iterate.com/voice-agent/conversation-end-requested",
    "events.iterate.com/voice-agent/conversation-ended",
    "events.iterate.com/voice-agent/provider-error",
    "events.iterate.com/voice-agent/spk-frame",
    "events.iterate.com/voice-agent/grok-event",
  ],
});
export type VoiceAgent2Contract = typeof VoiceAgent2Contract;

/**
 * Everything whose lifetime is ONE ANSWER from the provider.
 *
 * REPLACED WHOLESALE at `response.created` — the first event that can only
 * belong to a live answer — instead of hand-reset field by field. The hand
 * lists disagreed: `endsWhenQueueDrains` was reset by neither
 * `response.created` nor the hang-up, and the stale flag could fire
 * `lastFrameOfAnswer` in the middle of the next answer. An object that is
 * swapped cannot forget a field.
 */
interface Answer {
  /**
   * The provider's identity for the answer now playing, beside the two
   * clocks a truthful interruption needs (`receivedMs`, `sentMs`). On a
   * barge, `conversation.item.truncate` gets heard-ms (sent minus what the
   * clear threw out of the device's buffer) — trimming the item's audio AND
   * transcript so the model remembers what the listener heard, not what it
   * generated. Measured before this existed: barged eight seconds into a
   * count, the model claimed "26" — the generated frontier, not the heard
   * one.
   */
  itemId: string | null;
  contentIndex: number;
  /** How much of the answer was RECEIVED from the provider, in audio ms. */
  receivedMs: number;
  /** How much of it was actually HANDED TO THE DEVICE, in audio ms. */
  sentMs: number;
  /**
   * The provider's own transcript of the answer now playing, snapshotted at
   * the barge. Truncation deletes the item's transcript WHOLESALE (the
   * provider's documented behaviour), and the model grounds "what did I say"
   * in text, not in its own audio — truncated without help it swings to "I
   * never even started". The repair is a system note carrying the transcript
   * AS OF THE PRESS, whole: the transcript stream lags the audio stream by
   * seconds (measured: 28 characters of transcript against 17 s of received
   * audio at cancel), so a ratio cut over it starves the note — while the
   * lag itself lands the snapshot naturally near the heard boundary.
   */
  transcript: { atAnswerAudioMs: number; text: string }[];
  /**
   * A response is streaming right now (between `response.created` and its
   * `response.output_audio.done`) — the precondition for `response.cancel`
   * meaning anything. Without the gate, every ordinary press (no answer
   * playing, which is most of them) would draw a "nothing to cancel" error
   * event from the provider.
   */
  responseActive: boolean;
  /**
   * A barge cancelled the active response; its remaining deltas are dead.
   *
   * `response.cancel` is asynchronous — audio of the cancelled answer keeps
   * arriving until the provider processes it — and the queue-emptying in
   * #dropAnswerInFlight only discards what has ALREADY arrived. Without this
   * flag the residue refills the queue and the dead answer audibly resumes:
   * measured 2026-08-18 on gpt-realtime, "count to a hundred" counted right
   * through a barge, because openai streams near real time (grok bursts the
   * whole answer up front, which is why the same gap never sounded on grok).
   * Cleared by the next `response.created`, the first event that can only
   * belong to a LIVE answer.
   */
  dropDeltasUntilResponseCreated: boolean;
  /**
   * The provider has finished this answer; say so once the queue is empty.
   *
   * Deliberately NOT "mark the frame that happens to be last": that rule is
   * what made the flag losable. This is a question asked at the drain point,
   * where the answer is always knowable.
   */
  endsWhenQueueDrains: boolean;
}

/** The between-answers state: nothing playing, nothing owed. */
const freshAnswer = (): Answer => ({
  itemId: null,
  contentIndex: 0,
  receivedMs: 0,
  sentMs: 0,
  transcript: [],
  responseActive: false,
  dropDeltasUntilResponseCreated: false,
  endsWhenQueueDrains: false,
});

/**
 * Everything whose lifetime is one provider dial.
 *
 * CREATED BEFORE THE AWAITED DIAL — `socket` stays null while the dial is in
 * flight, which is what lets the mic path keep queueing during the handshake
 * — and dropped whole when the dial fails, its socket closes, or the call is
 * hung up. One object where the hand-maintained reset lists used to
 * disagree: the dial block reset 19 fields, `response.created` 7, `#hangUp`
 * 6, and the fields in nobody's intersection were exactly where the last two
 * stale-state bug hunts ended. A hang-up is now one assignment, and it
 * cannot forget a field.
 */
interface Dial {
  /** The provider's socket, or null while the dial is still in flight. */
  socket: WebSocket | null;
  /** True once the provider's handshake completed and audio may flow. */
  ready: boolean;
  /**
   * Paced answer audio waiting for its turn on the wire, oldest first.
   *
   * NOTHING IN HERE HAS A SEQUENCE NUMBER YET, and that is the point. A number
   * is minted when a frame is HANDED TO THE STREAM, so a number existing means
   * a frame left this machine — which is what makes a hole in the numbering
   * mean one thing instead of two. Numbered at queue time, a barge-in that
   * discarded the queue burned the numbers with it, and the device scored the
   * cancelled audio as lost audio: 5 gaps and 423 absent numbers on a
   * seven-minute call where nothing had actually gone missing.
   */
  speakerQueue: Uint8Array[];
  /** Last speaker-frame sequence number minted, for this call. */
  lastDeviceSpeakerFrameSeq: number;
  /**
   * How far a clear has already been declared, so a jittery detector is free.
   *
   * Five `speech_started` in one answer was measured on real hardware. The
   * first moves this to the highest frame minted; the other four find nothing
   * new below it and cost one comparison each.
   */
  clearedThroughDeviceSpeakerFrameSeq: number;
  /**
   * The next frame out must tell the device to empty its speaker first.
   *
   * TRUE FROM THE MOMENT THE DIAL IS DECIDED, which is what lets the
   * sequence restart at one. The device may still be holding frames from the
   * incarnation that died, numbered higher than the ones about to arrive.
   * Rather than remembering how high — a durable number, written to survive
   * a thing that cannot be survived — the first frame of the new session
   * simply says "clear". Whatever the board was holding belonged to an
   * answer whose socket is gone; nobody wants to hear the rest of it anyway.
   * Consumed by the sender, so it costs nothing when there is no audio to
   * send — an idle call never issues a clear nobody needed.
   */
  clearSpeakerBufferBeforeNextFrame: boolean;
  /**
   * When the device will run dry, on the facet clock. The only pacing state,
   * and the whole model of its memory:
   *
   *   heldBytes = max(0, deviceBufferEmptyAtFacetMs - now) * PCM16_BYTES_PER_MS
   *
   * A deadline rather than a byte count beside a timestamp, because a deadline
   * drains implicitly with the clock. The pair would need a decay tick to stay
   * honest, and a decay tick that stops running is a field that silently lies.
   */
  deviceBufferEmptyAtFacetMs: number;
  /**
   * One sender at a time — PER DIAL, so a pacer that outlives its dial
   * cannot hold the next dial's lock: the identity fence retires it, the
   * release frees only its own dial, and the new dial's pacer starts clean.
   */
  sending: boolean;
  /**
   * A tentative VAD onset holding the floor, or null.
   *
   * SET ONLY WHEN NOTHING IS GENERATING, which is grok's shape: whole
   * answers burst up front, so by the time `speech_started` fires the
   * unsent tail — up to ~36 s of a long answer against the device's ≤4 s
   * lead — exists ONLY in `speakerQueue`. And the onset is TENTATIVE:
   * five per turn were measured from echo residue, each retracting as a
   * `speech_stopped` with no commit behind it. So the onset silences the
   * DEVICE (the numbered clear — the interrupt still feels instant) but
   * keeps the queue and pauses the pacer until there is a verdict:
   *
   *   CONFIRMS: `input_audio_buffer.committed` or `response.created` — a
   *   turn really happened. The tail is discarded and the memory repair
   *   runs with `heardMs`.
   *
   *   RETRACTS: `speech_stopped` with no commit — residue. The tail
   *   resumes. What a false onset costs now is the HOLE: the device's
   *   cleared lead is not resent, so playback skips it — bounded by the
   *   ≤4 s the device held, against the whole tail before.
   *
   * `heardMs` is frozen AT the onset because the schedule keeps advancing
   * while the verdict is out, and the repair must name what was heard at
   * the silence, not at the commit. `retracted` keeps the frozen number
   * through a resume rather than erasing it: a real turn's
   * `speech_stopped` and `committed` arrive in the same server tick, and
   * the commit still owes the repair. The hold dies when the tail
   * finishes playing whole (the drain marker — nothing left to repair,
   * and a stale frozen number must never truncate an answer that was
   * heard entire) or with the dial.
   */
  tentativeOnset: { heardMs: number; retracted: boolean } | null;
  /**
   * The two rate converters, one per direction, minted with the dial for
   * whatever rate its provider speaks (an identity for grok's native
   * 16 kHz). Instances rather than calls because the conversion phase must
   * survive the chunking: a provider flushes deltas at whatever cadence it
   * likes, and resampling each delta as its own little signal put a seam at
   * every boundary — see pcm.ts. The speaker side resets per answer; the
   * mic side is one continuous capture for the whole dial.
   */
  micResampler: Pcm16Resampler;
  spkResampler: Pcm16Resampler;
  /**
   * A truncate that must wait for the cancelled response to FINALIZE.
   *
   * Sent back-to-back with `response.cancel`, the truncate races the
   * server finalizing the item — observed live: the ack and the response's
   * `done` share a millisecond, and the model still remembered the full
   * count. The provider processes client events in order, but the item's
   * transcript is written at finalization; truncating a still-finalizing
   * item is undefined in exactly the way that bit us. Held here until the
   * `response.done` arrives, then sent against a settled item.
   */
  pendingTruncate: { itemId: string; contentIndex: number; audioEndMs: number } | null;
  /**
   * Tool calls issued by the model and not yet answered, by provider call_id.
   * Grok documents parallel calls as "all outputs, then ONE response.create";
   * the follow-up fires when this empties. A future Gemini listener would
   * delete ids here on toolCallCancellation.
   */
  openToolCallIds: Set<string>;
  /**
   * The model decided the call is over; settle at the drain point, after the
   * goodbye PLAYS. v1's instant version was measured cutting "Goodbye!"
   * mid-word. Runtime on purpose: evicted, the 60s idle deadline backstops.
   */
  hangUpAfterAnswerDrains: string | null;
  /** The answer in flight — replaced wholesale at `response.created`. */
  answer: Answer;
}

/** A dial just decided: no socket yet, nothing sent, a clear owed first. */
const freshDial = (providerRate: number): Dial => ({
  socket: null,
  ready: false,
  speakerQueue: [],
  lastDeviceSpeakerFrameSeq: 0,
  clearedThroughDeviceSpeakerFrameSeq: 0,
  clearSpeakerBufferBeforeNextFrame: true,
  deviceBufferEmptyAtFacetMs: 0,
  sending: false,
  tentativeOnset: null,
  micResampler: new Pcm16Resampler(16_000, providerRate),
  spkResampler: new Pcm16Resampler(providerRate, 16_000),
  pendingTruncate: null,
  openToolCallIds: new Set(),
  hangUpAfterAnswerDrains: null,
  answer: freshAnswer(),
});

/* ========================================================================== */
/* PROCESSOR                                                                  */
/* ========================================================================== */

export class VoiceAgent2Processor extends StreamProcessor<
  VoiceAgent2Contract,
  {
    /** The facet clock. Every `...AtFacetMs` in this file comes from here. */
    nowAtFacetMs(): number;
    /** The only way this processor waits, injected so tests use a fake clock. */
    sleep(ms: number): Promise<void>;
    dialProvider(
      provider: VoiceProvider,
      baseUrl: string | null,
      model: string,
    ): Promise<WebSocket | null>;
    /**
     * Open a fresh project itx session, use it, dispose it. Stubs from
     * `env.ITX.get()` must not outlive the invocation that dialed them, so
     * every tool call opens its own — the SDK's own pattern (its alarm proxy
     * does exactly this from inside the facet), inherited rather than
     * invented.
     */
    withProject<T>(fn: (project: unknown) => Promise<T>): Promise<T>;
  }
> {
  readonly contract = VoiceAgent2Contract;

  /* --------------------------------------------------------- runtime state */
  /* Every one of these dies with the incarnation on purpose. Anything that
   * must outlive an eviction is in the fold above. */

  /**
   * The dial this incarnation is running, or null when there is none.
   *
   * ONE DIAL AT A TIME: created synchronously the moment a dial is decided —
   * so two caught-up deliveries cannot open two sockets — and null again
   * when the dial fails, its socket closes, or the call is hung up.
   * Everything scoped to the dial lives ON it (see {@link Dial}), which is
   * what lets a hang-up be one assignment instead of a hand-reset list, and
   * lets every closure the dial spawns fence itself with `this.#dial !==
   * dial` — strictly stronger than the socket-identity check it replaces.
   */
  #dial: Dial | null = null;
  /**
   * Capture that arrived before Grok's handshake finished, oldest first.
   *
   * Bytes and nothing else: `deviceMicFrameSeq` belongs to the device and is
   * never renumbered here, so holding a copy of it would be a field nobody
   * reads. Order in this array IS the order it was captured in.
   *
   * NOT ON THE DIAL, because it can start filling before one exists: a
   * revived incarnation holds frames from deliveries that arrive before the
   * caught-up pass re-dials, and they must survive INTO that dial's
   * session.updated flush — which is why the dial's own reset never touched
   * this queue either.
   */
  #micQueue: Uint8Array[] = [];
  /**
   * The device finished its turn while the handshake was still in flight.
   * Like `#micQueue` it is NOT on the dial: the turn can end before the
   * dial exists, and the flag must survive into it.
   *
   * THE HALF OF THE BUFFER THAT WAS MISSING. Capture arriving early was held
   * and replayed; the `ptt-end` that turns that capture into a QUESTION was
   * dropped on the floor, because committing needs a socket and there wasn't
   * one yet. Measured on a real session: 296 frames held and flushed into the
   * provider — `heldMicFrames: 296` in the acceptance — and then silence,
   * because nothing ever asked it to answer. The person had spoken a whole
   * sentence to something that was still politely listening a minute later,
   * when the idle deadline ended the call.
   *
   * A boolean rather than a queue: a turn that ended is a turn that ended, and
   * two presses inside one handshake still owe exactly one commit.
   */
  #turnEndedDuringHandshake = false;

  /**
   * A call has been ASKED for, and the log has not caught up yet.
   *
   * An append is not instant, so between asking for a call and the fold showing
   * one there is a window in which `state.call` is still null. A board streams
   * microphone frames continuously, so that window is never empty — the first
   * batch after a call opens is three or four frames, and without this every
   * one of them minted its own conversation. Idempotency keys cannot help: each
   * frame proposes a DIFFERENT id, so each key is genuinely new.
   *
   * A BOOLEAN, because nothing reads which id it was. There is deliberately no
   * mirror-image field for a call this incarnation has BURIED: `endRequested`
   * in the fold is that, it is strictly stronger — it survives the eviction a
   * runtime field does not — and the guard that reads it runs first.
   */
  #callRequested = false;
  /**
   * The fold's `lastDeviceInputAtStreamMs`, refreshed on every delivery.
   *
   * A MIRROR, never a second source of truth: the idle loop runs between
   * deliveries and has no way to read the fold, and closing over a stamp would
   * miss a call kept alive by frames that arrived after it started waiting.
   * Written only from `state`.
   */
  #lastDeviceInputAtStreamMsMirror = 0;

  /* ------------------------------------------------------------------ fold */

  reduce({ state, event }: ReduceArgs<VoiceAgent2Contract>) {
    const committedAtStreamMs = Date.parse(event.createdAt);
    switch (event.type) {
      case "events.iterate.com/voice-agent/created":
        /* Existence is the event's whole content, and the fold's defaults
         * already ARE the unconfigured agent — an existence flag beside them
         * would be a field nothing reads. Returning state unchanged is the
         * honest arm. */
        return state;

      case "events.iterate.com/voice-agent/configured":
        /* REPLACED WHOLESALE, defaults and all: an absent field resets rather
         * than survives, so a rerun of setup with a shorter config cannot
         * leave last week's tools armed. */
        return {
          ...state,
          providerBaseUrl: event.payload.providerBaseUrl ?? null,
          provider: event.payload.provider ?? "grok",
          providerModel: event.payload.providerModel ?? null,
          providerVoice: event.payload.providerVoice ?? null,
          instructions: event.payload.instructions ?? "",
          clientTakesTurns: event.payload.clientTakesTurns ?? false,
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
        /* Their BODIES never reach the fold — that would be state depending on
         * a queue no restart can replay — but their commit stamps are as
         * durable as any event's, and folding the newest is what makes the idle
         * deadline outlive an eviction. `max` so a redelivered batch cannot
         * walk the deadline backwards, and IDLE_STAMP_STEP_MS so fifty frames
         * a second do not dirty the state fifty times a second. */
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

      default:
        return state;
    }
  }

  /* ----------------------------------------------------------------- react */

  processEvent(args: ProcessEventArgs<VoiceAgent2Contract>): undefined {
    const { state, event, delivery, append, runInBackground } = args;

    /* The log has caught up with whichever append we were remembering for it;
     * both memories exist only to cover the gap, so both end here. */
    if (state.call === null) {
    } else {
      this.#callRequested = false;
      this.#lastDeviceInputAtStreamMsMirror = state.call.lastDeviceInputAtStreamMs;
    }

    /*
     * THE CAUGHT-UP PASS IS THE RECOVERY, and it runs FIRST.
     *
     * An eventless caught-up delivery is how a revived incarnation learns it
     * owes a call, so this cannot sit behind the event switch — every arm of
     * which returns, and one of them (a microphone frame on a socketless
     * incarnation) is exactly the delivery that has to reach here.
     */
    const owedCall = delivery.caughtUp ? state.call : null;
    /*
     * AN OBITUARY NOBODY WROTE IS A CALL NOBODY CAN END. Somebody decided this
     * call was over; if the incarnation that decided died before writing the
     * ending, the fold says `endRequested` for ever, nothing re-dials it, and
     * nothing buries it. Re-running it here is what retries a refused or
     * interrupted obituary — idempotent by key, so the ordinary path landing it
     * first costs nothing. This is why `endRequested` keeps the REASON: the
     * incarnation that finishes the job is usually not the one that decided.
     */
    if (owedCall !== null && owedCall.endRequested !== null) {
      const { conversationId, endRequested } = owedCall;
      this.#hangUp();
      /* A settlement at head: losing this append forever is a call the fold
       * says is ending and nothing ever buries. The cursor waits the one
       * colocated write. */
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
        /*
         * DECODED ONCE, HERE, so no path below can forget to. The three places
         * that hand microphone audio on — held for a call being opened, held
         * for a handshake in flight, and straight to a live socket — each used
         * to do their own `base64ToBytes`, and the encoding is the kind of
         * thing that gets fixed in two of three.
         */
        const micPcm16 =
          event.type === "events.iterate.com/voice-agent/mic-frame"
            ? base64ToBytes(event.payload.pcm)
            : null;
        /*
         * A CALL IS OPENED BY SOMEBODY TALKING, not by anybody asking for one.
         * The device has no way to know whether a call exists, and asking it to
         * say made two sources of truth for one fact.
         */
        /*
         * A TURN CAN END BEFORE THE LOG KNOWS A CALL BEGAN, and the fold is
         * several hundred milliseconds behind a person letting go of a button.
         * Recorded HERE, at the top of the case, because every interesting
         * branch below returns early and one of them is the ordinary case —
         * speak, release, all inside one round trip. This is the ONLY
         * recorder: the live-call ptt-end arm at the bottom used to latch the
         * flag again for a dial mid-handshake, and every delivery that
         * reached that arm had already passed through this line.
         */
        if (
          event.type === "events.iterate.com/voice-agent/ptt-end" &&
          state.clientTakesTurns &&
          this.#dial?.ready !== true &&
          /* Only a turn belonging to a REAL opening call may be held over
           * the handshake: a stray ptt-end with no call would leave the flag
           * latched, and the NEXT press's session.updated would commit
           * mid-sentence off a button nobody was holding. */
          (state.call !== null || this.#callRequested)
        ) {
          this.#turnEndedDuringHandshake = true;
        }
        if (state.call === null) {
          if (this.#callRequested) {
            /* Already asked. Hold this frame for the call that is coming. */
            if (micPcm16 !== null && this.#micQueue.length < MAX_HELD_MIC_FRAMES) {
              this.#micQueue.push(micPcm16);
            }
            return;
          }
          /* ONLY SPEECH OPENS A CALL. The ephemeral lane drops and
           * re-delivers, so a lone ptt-end arrives here — and a call minted
           * for it would commit an EMPTY provider buffer: a provider error
           * plus, sometimes, an unprompted answer spoken from bare context,
           * then a zombie call squatting out the idle deadline. */
          if (event.type === "events.iterate.com/voice-agent/ptt-end") return;
          const conversationId = `conv_${crypto.randomUUID()}`;
          this.#callRequested = true;
          /* The one append the whole call hangs off: if it silently fails,
           * #callRequested can never clear (its only clear needs the fold
           * this append produces) and the incarnation is deaf until
           * eviction. The cursor waits the one write; a refusal un-asks. */
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
           * DIAL NOW, NOT WHEN THE LOG AGREES. The append above is the durable
           * record that a call was opened; it is not permission to open one.
           * Waiting for it to come back and be folded put a full stream round
           * trip in front of every first word — measured at 7.4 seconds on a
           * real session, against a provider handshake of 973 ms.
           */
          this.#openProviderConnection(conversationId, state, append, runInBackground);
          if (micPcm16 !== null && this.#micQueue.length < MAX_HELD_MIC_FRAMES) {
            this.#micQueue.push(micPcm16);
          }
          return;
        }
        if (state.call.endRequested !== null) return;

        /*
         * THE BUTTON IS AN INTERRUPTION, and in push-to-talk it is the ONLY
         * one anybody sends. `turn_detection` is null when the client owns its
         * turns, so the provider never reports speech starting and the two
         * provider events that used to be the whole of barge-in cannot fire.
         * Without this line the dead answer keeps streaming to the speaker for
         * the entire press and only stops when the NEXT answer begins.
         *
         * Dropping what arrived is half the interruption; the other half is
         * telling the provider to STOP GENERATING. `response.cancel` ends the
         * active response (both providers speak it — one API is a clone of
         * the other), which is also what frees the provider to accept the
         * commit this press is about to produce. Until the cancel lands, the
         * dead answer's residue keeps arriving — the answer's
         * `dropDeltasUntilResponseCreated` is what keeps it out of the
         * speaker queue.
         */
        if (event.type === "events.iterate.com/voice-agent/ptt-start") {
          const dial = this.#dial;
          /* No dial means nothing playing and nothing to cancel: a press on
           * a revived incarnation that has not re-dialled yet changes
           * nothing until the caught-up pass opens the connection. */
          if (dial !== null) {
            /* A press UN-DECIDES a pending hang-up: the user talked past the
             * goodbye. The model already heard "hanging up" as its tool
             * output; the transcript shows what happened next — the truth. */
            dial.hangUpAfterAnswerDrains = null;
            /* Heard-ms must be read BEFORE the drop zeroes the pacer's
             * schedule: sent audio minus what still sat in the device's buffer
             * when the clear threw it away. (A `spkBufferedMs` device stamp
             * was read here as the preferred source — the device is the
             * authority on what it played, and the schedule models the WORST
             * CASE lead — but no device or CLI ever produced the field, so
             * the read was a branch that had never once run. Deleted; if a
             * device grows the stamp, declare it in the ptt-start contract
             * and take it as the authority again.) */
            const nowAtFacetMs = this.deps.nowAtFacetMs();
            const heardMs = this.#heardMsFromSchedule(dial, nowAtFacetMs);
            this.#dropAnswerInFlight(dial, state.call.conversationId, nowAtFacetMs, append);
            if (dial.ready && dial.socket !== null) {
              const responseWasActive = dial.answer.responseActive;
              this.#repairBargedAnswerMemory(dial, heardMs, state.call.conversationId, append);
              /* THE PRESS OWNS CANCELLATION, and it is the ONLY barge arm
               * that sends it: turn_detection is null in push-to-talk, so no
               * provider VAD will ever cancel for a button. The
               * speech_started arm must NOT send this — OpenAI's server_vad
               * `interrupt_response` (pinned true in our session.update) has
               * already cancelled server-side at the onset, and grok drew an
               * error every time a VAD-triggered cancel was tried. */
              if (responseWasActive) {
                this.#sendControl(
                  dial,
                  { type: "response.cancel" },
                  state.call.conversationId,
                  append,
                );
              }
            }
          }
        }

        if (micPcm16 !== null) {
          const dial = this.#dial;
          if (dial !== null && dial.ready && dial.socket !== null) {
            /* Held frames resample at the flush; live ones resample here.
             * The queue itself stays 16 kHz so a re-dial to a DIFFERENT
             * provider never replays audio at the wrong rate. */
            dial.socket.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: bytesToBase64(dial.micResampler.push(micPcm16)),
              }),
            );
          } else if (this.#micQueue.length < MAX_HELD_MIC_FRAMES) {
            this.#micQueue.push(micPcm16);
          }
          return;
        }
        /* A client that owns its turns commits them; when Grok is listening,
         * its buttons — if it has any — say nothing, because server VAD on top
         * of a button answers halfway through a sentence. No else-arm holding
         * the turn over the handshake here: the recorder at the top of this
         * case already latched #turnEndedDuringHandshake for exactly the
         * dial-not-ready deliveries that reach this line. */
        if (event.type === "events.iterate.com/voice-agent/ptt-end" && state.clientTakesTurns) {
          const dial = this.#dial;
          if (dial !== null && dial.ready && dial.socket !== null) this.#askForAnswer(dial.socket);
        }
        return;
      }

      /* There is NO conversation-end-requested arm. reduce folds the decision
       * before delivery reaches this switch, so the caught-up pass above has
       * already hung up and written the obituary on the very delivery that
       * carried the event — and it, unlike an arm, also retries an obituary
       * that an earlier incarnation died owing. An arm here was the same
       * action twice behind one idempotency key. */

      case "events.iterate.com/voice-agent/conversation-ended":
        /* NAMED, like every other arm. Without the check, a redelivered
         * obituary for a call that ended ten minutes ago hangs up the one
         * happening now — and silently, because the close listener's own fence
         * swallows the socket close that follows. */
        if (state.call !== null && state.call.conversationId === event.payload.conversationId) {
          this.#hangUp();
        }
        return;

      default:
        return;
    }
  }

  /**
   * Open a provider connection for this call, now.
   *
   * WHY THIS IS CALLED FROM TWO PLACES. It used to run only on a caught-up
   * delivery, reading the call out of REDUCED state — so opening a
   * connection meant appending `call-started`, waiting for the log to
   * deliver it back, waiting for the fold, and only then dialling. Measured
   * on a real session: `call-started` at 12.6s and the provider accepted at
   * 21.0s, of which the handshake itself was 973ms. Seven and a half seconds
   * of a person waiting for a full stream round trip that told this
   * incarnation something it already knew.
   *
   * The caught-up path is still here and still needed — it is how a REVIVED
   * incarnation learns it owes a call nobody is dialling. The dial object's
   * synchronous creation is what makes the two callers safe together.
   */
  #openProviderConnection(
    conversationId: string,
    state: ProcessEventArgs<VoiceAgent2Contract>["state"],
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgent2Contract>["runInBackground"],
  ): void {
    if (this.#dial !== null) return;
    const provider = PROVIDERS[state.provider];
    /* CREATED BEFORE THE AWAITED DIAL, so a second caller finds `#dial`
     * taken and the mic path queues for the whole handshake. The socket
     * arrives below; everything else the dial owns starts fresh here. */
    const dial = freshDial(provider.rate);
    this.#dial = dial;
    const dialStartedAtFacetMs = this.deps.nowAtFacetMs();
    /* THIS DIAL'S OWN IDENTITY, for keys that must not collide with the
     * previous dial of the SAME call. A timestamp is not enough: a re-dial
     * inside the same millisecond — or on a test's virtual clock, which does
     * not move on its own — reuses it. */
    const dialId = crypto.randomUUID();
    runInBackground(async () => {
      /* A dial can REJECT (DNS, TLS), not just refuse — and an uncaught
       * throw here was measured as sixty seconds of dead air: the runner
       * logs it, nothing appends, nothing re-dials, and the user's whole
       * held sentence waits out the idle deadline. A throw IS a refusal. */
      let socket: WebSocket | null;
      try {
        socket = await this.deps.dialProvider(
          state.provider,
          state.providerBaseUrl,
          state.providerModel ?? provider.model,
        );
      } catch (error) {
        if (this.#dial === dial) this.#dial = null;
        await append({
          type: "events.iterate.com/voice-agent/conversation-end-requested",
          idempotencyKey: this.idempotencyKey(`dial-failed:${conversationId}`),
          payload: {
            conversationId,
            reason: `the provider dial failed: ${String(error).slice(0, 200)}`,
          },
        });
        return;
      }
      if (socket === null) {
        if (this.#dial === dial) this.#dial = null;
        await append({
          type: "events.iterate.com/voice-agent/conversation-end-requested",
          idempotencyKey: this.idempotencyKey(`dial-failed:${conversationId}`),
          payload: { conversationId, reason: "Grok refused the connection" },
        });
        return;
      }
      if (this.#dial !== dial) {
        /* Hung up while dialling: the call this socket was for is already
         * over, and adopting it would resurrect a buried conversation. */
        try {
          socket.close();
        } catch {
          /* Already gone. */
        }
        return;
      }
      dial.socket = socket;

      /*
       * THE THIRD SWITCH, AND WHY IT IS NOT A STREAM EVENT.
       *
       * Everything else in this file reaches `processEvent` by being
       * appended. Grok's messages do not, and the reason is measured rather
       * than stylistic: the ephemeral lane coalesces, delivering in clumps
       * seconds late. Routing an audio delta through it before acting on it
       * would put a second full stream round trip in front of the first word
       * of every answer. The provider's timeline is still appended for
       * instruments — just not waited for, and see `#forwardProviderEvent` for the
       * one part of it that is not.
       */
      socket.addEventListener("message", (message: MessageEvent) => {
        /*
         * A SUPERSEDED SOCKET IS STILL A TALKING SOCKET, and this is the
         * fence. `close()` is not instant and a message already in flight
         * arrives after it: without this line a late `session.updated` from
         * an abandoned socket marked the call ready again, emptied the
         * microphone queue into a dead connection, and — because the dial
         * guard reads the same field — let a SECOND socket be opened while
         * the first was still delivering. The close listener has always had
         * this check; the message listener is the one that needed it. The
         * fence is the DIAL's identity rather than the socket's — strictly
         * stronger: it also retires a listener whose call was hung up while
         * its socket lingered.
         */
        if (this.#dial !== dial) return;
        if (typeof message.data !== "string") return;
        let grok: Record<string, unknown>;
        try {
          grok = JSON.parse(message.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const providerEventType = String(grok.type ?? "");
        const receivedAtFacetMs = this.deps.nowAtFacetMs();
        this.#forwardProviderEvent(
          grok,
          providerEventType,
          conversationId,
          receivedAtFacetMs,
          append,
        );

        switch (providerEventType) {
          case "session.created":
            /* The one edge that makes us configure the session; miss it and
             * the handshake never completes and the call hangs, silently. */
            socket.send(
              JSON.stringify({
                type: "session.update",
                session: {
                  type: "realtime",
                  ...(state.instructions === "" ? {} : { instructions: state.instructions }),
                  /* The certificate's tools, declared verbatim; the GA shape
                   * both providers speak. The expression never touches the
                   * wire — the provider knows names, we know what they do. */
                  ...(state.tools.length > 0 && {
                    tool_choice: "auto",
                    tools: state.tools.map(({ name, description, parameters }) => ({
                      type: "function",
                      name,
                      description,
                      parameters: parameters ?? { type: "object", properties: {} },
                    })),
                  }),
                  audio: {
                    input: {
                      format: { type: "audio/pcm", rate: provider.rate },
                      /*
                       * SINGLE-OWNER SEMANTICS, MADE VISIBLE. The VAD barge
                       * arm RELIES on the provider cancelling a barged
                       * response server-side at the onset — that is why it
                       * never sends response.cancel — and on OpenAI that
                       * behaviour is `interrupt_response`, a DEFAULT today.
                       * A default is a dependency nobody can grep for, so
                       * both booleans are pinned to what the machinery
                       * already assumes. `silence_duration_ms: 500` pins the
                       * documented default too: it sits inside every
                       * turn-end latency ever measured here, and tuning it
                       * should be an edit, not an archaeology dig. Grok
                       * keeps bare SERVER_VAD — its support for these knobs
                       * is unprobed, and an unknown key in its session has
                       * not been tried against a live socket.
                       */
                      turn_detection: state.clientTakesTurns
                        ? null
                        : state.provider === "openai"
                          ? {
                              ...SERVER_VAD,
                              interrupt_response: true,
                              create_response: true,
                              silence_duration_ms: 500,
                            }
                          : SERVER_VAD,
                      /* The boards are far-field boxes, and the 0.85 VAD
                       * threshold exists because of their echo residue —
                       * this is the knob that may one day let it drop.
                       * OpenAI-only: grok's docs are silent on it. */
                      ...(state.provider === "openai" && {
                        noise_reduction: { type: "far_field" },
                      }),
                    },
                    output: {
                      format: { type: "audio/pcm", rate: provider.rate },
                      voice: state.providerVoice ?? provider.voice,
                    },
                  },
                },
              }),
            );
            return;

          case "session.updated": {
            /* Usable. Everything the handshake made us hold goes now. */
            dial.ready = true;
            const heldMicFrames = this.#micQueue.length;
            for (const held of this.#micQueue) {
              socket.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: bytesToBase64(dial.micResampler.push(held)),
                }),
              );
            }
            this.#micQueue = [];
            /*
             * AND THE END OF THE TURN, if it happened while we were connecting.
             * The held capture is only a question once somebody commits it —
             * without this the provider holds a complete sentence in its input
             * buffer and waits, for ever, for an instruction that was thrown
             * away sixty seconds earlier.
             */
            if (this.#turnEndedDuringHandshake && state.clientTakesTurns) {
              this.#askForAnswer(socket);
            }
            this.#turnEndedDuringHandshake = false;
            this.runInBackground(() =>
              append({
                type: "events.iterate.com/voice-agent/conversation-accepted",
                /* PER DIAL, not per conversation. A call rescued after an
                 * eviction handshakes a second time and its numbers are its
                 * own; keyed on the conversation, that append is refused
                 * outright and the re-dial cannot record it happened. */
                idempotencyKey: this.idempotencyKey(`accepted:${conversationId}:${dialId}`),
                payload: {
                  conversationId,
                  handshakeTookMs: receivedAtFacetMs - dialStartedAtFacetMs,
                  heldMicFrames,
                },
              }),
            );
            return;
          }

          case "input_audio_buffer.committed":
            /* A commit is a turn that really happened, so the onset that
             * preceded it was no echo blip. A RETRACTED hold confirms here
             * too: a real turn's speech_stopped and committed arrive in the
             * same server tick, and the frozen number from the silence is
             * still the honest one. */
            this.#confirmTentativeOnset(dial, conversationId, append);
            return;

          case "input_audio_buffer.speech_started":
            /*
             * THE BOARDS' ONLY BARGE. An open microphone has no button, so
             * this onset is the one interruption an open-mic client ever
             * produces — and it is TENTATIVE: five per turn were measured
             * from echo residue, each retracting as a `speech_stopped` with
             * no commit behind it. Which story it opens depends on whether
             * the provider is still generating.
             */
            if (dial.answer.responseActive) {
              /*
               * STILL GENERATING (openai streams near real time): the answer
               * in flight dies exactly as a press kills it — queue, device
               * clear, memory repair — with ONE deliberate omission: no
               * `response.cancel`. OpenAI's server_vad `interrupt_response`
               * (pinned true in our session.update) means the provider
               * already cancelled this response server-side at this very
               * onset — a client cancel on top is a second owner of one
               * cancellation. And grok drew an error every time a
               * VAD-triggered cancel was tried. The
               * barged response still finalizes with a `response.done`,
               * which is where the pending truncate settles.
               *
               * Heard-ms is read BEFORE the drop zeroes the pacer's
               * schedule, same as the press.
               */
              const heardMs = this.#heardMsFromSchedule(dial, receivedAtFacetMs);
              this.#dropAnswerInFlight(dial, conversationId, receivedAtFacetMs, append);
              this.#repairBargedAnswerMemory(dial, heardMs, conversationId, append);
              return;
            }
            /*
             * GENERATION ALREADY FINISHED (grok bursts whole answers up
             * front): the unsent tail — up to ~36 s against the device's
             * ≤4 s lead — lives ONLY in the local queue, and emptying it on
             * a tentative onset was the counting bug in a second form: the
             * header's "one flush and four no-ops" was true of the DEVICE's
             * buffer and false of this one. So the device is silenced NOW
             * (the numbered clear — the interrupt still feels instant), the
             * schedule is zeroed to say so, and the queue WAITS:
             *
             *   CONFIRMS: `input_audio_buffer.committed` or
             *   `response.created` — discard the tail, repair the memory.
             *
             *   RETRACTS: `speech_stopped` with no commit — the tail
             *   resumes. The false onset costs the HOLE where the device's
             *   cleared lead was (≤4 s, not resent), against the whole tail
             *   it used to cost.
             *
             * Heard-ms freezes HERE — the schedule keeps advancing while
             * the verdict is out, and a confirm must repair to what was
             * heard at the silence, not at the commit. A blip landing on an
             * onset a retraction just released re-freezes: more was heard
             * since.
             */
            if (dial.tentativeOnset === null || dial.tentativeOnset.retracted) {
              dial.tentativeOnset = {
                heardMs: this.#heardMsFromSchedule(dial, receivedAtFacetMs),
                retracted: false,
              };
            }
            this.#clearDeviceSpeaker(dial, conversationId, receivedAtFacetMs, append);
            dial.deviceBufferEmptyAtFacetMs = 0;
            return;

          case "input_audio_buffer.speech_stopped":
            /* The retraction half of a tentative onset: the room went quiet
             * and no commit followed — residue, so the held tail resumes.
             * The hold keeps its frozen heard-ms rather than dying, because
             * a REAL turn's speech_stopped is followed by its committed in
             * the same server tick and that commit still owes the repair;
             * frames the resume lets slip in that gap are re-cleared by the
             * confirm's own watermark. */
            if (dial.tentativeOnset !== null && !dial.tentativeOnset.retracted) {
              dial.tentativeOnset.retracted = true;
              this.#sendSpeakerAudio(dial, conversationId, append, runInBackground);
            }
            return;

          case "response.created":
            /* A created event can only belong to a LIVE answer, so it is
             * what ends a barge's residue-discard window — and it is where
             * the per-answer state is replaced WHOLESALE, identity and
             * clocks included. It also CONFIRMS a tentative onset, and must
             * do that FIRST: the repair reads the OLD answer's identity and
             * transcript, which the wholesale swap is about to erase. */
            this.#confirmTentativeOnset(dial, conversationId, append);
            dial.answer = freshAnswer();
            dial.answer.responseActive = true;
            /* A new answer is a new signal; without this, the filter's
             * held tail of a CANCELLED answer would smear its first
             * milliseconds. */
            dial.spkResampler.reset();
            this.#dropAnswerInFlight(dial, conversationId, receivedAtFacetMs, append);
            return;

          case "response.output_audio_transcript.delta":
            /* Tagged with the answer-audio position it ARRIVED at: the two
             * streams interleave with generation, so arrival position is the
             * closest thing the wire offers to "spoken at". Ratio cuts over
             * the concatenated text were wrong twice over (character length
             * is not time; the transcriber lags), and told a listener who
             * heard twelve numbers that they heard four. Residue still
             * accumulates — the note is sent after the cancel. */
            if (typeof grok.delta === "string") {
              dial.answer.transcript.push({
                atAnswerAudioMs: dial.answer.receivedMs,
                text: grok.delta,
              });
            }
            return;

          case "response.output_audio.delta": {
            if (typeof grok.delta !== "string") return;
            /* Residue of a cancelled answer: dead on arrival. */
            if (dial.answer.dropDeltasUntilResponseCreated) return;
            /*
             * CUT ONLY TO FIT THE DEVICE'S RECEIVE BUFFER. A delta is audio
             * of no particular length — measured against the real provider,
             * 0 of 77 in one answer were a multiple of anything — and the
             * board appends whatever bytes arrive to its speaker ring, so the
             * last piece of a delta being short costs nothing but one extra
             * append. Nothing is carried between deltas and nothing is padded.
             */
            /* The item identity rides every delta; remembering it here is
             * what lets a barge name the thing it truncates. */
            if (typeof grok.item_id === "string") dial.answer.itemId = grok.item_id;
            if (typeof grok.content_index === "number") {
              dial.answer.contentIndex = grok.content_index;
            }
            /* The pipeline is 16 kHz from here to the speaker; a provider
             * that talks faster gets resampled at the door. */
            const pcm16 = dial.spkResampler.push(base64ToBytes(grok.delta));
            dial.answer.receivedMs += pcm16.length / PCM16_BYTES_PER_MS;
            for (let cut = 0; cut < pcm16.length; cut += MAX_SPEAKER_PAYLOAD_BYTES) {
              dial.speakerQueue.push(
                pcm16.subarray(cut, Math.min(cut + MAX_SPEAKER_PAYLOAD_BYTES, pcm16.length)),
              );
            }
            this.#sendSpeakerAudio(dial, conversationId, append, runInBackground);
            return;
          }

          /*
           * THE ANSWER IS OVER, and the device does have to be told.
           *
           * This was deleted on the theory that a device which plays what
           * arrives needs no telling — its speaker goes quiet on its own. That
           * is true of the speaker and false of everything else: silence on
           * the wire is indistinguishable from a provider taking its time, so
           * a client waiting for the end of a turn waits for ever. Measured
           * on the host CLI, where every turn of a working call was reported
           * as a failure because the driver's `answer_done` never came.
           *
           * What is NOT restored is the old rule that lost it. `last` had to
           * be attached to whichever frame turned out to be final, and an
           * answer shorter than the head start had already been sent by the
           * time this arrived — nothing left to mark. Asking at the DRAIN
           * POINT instead makes it unloseable: if audio is still queued the
           * marker follows it, and if the queue is already empty the marker
           * is its own frame.
           */
          case "response.output_audio.done":
            /* The cancelled answer's own done is residue like its deltas:
             * marking end-of-answer for audio nobody heard would tell the
             * device a turn finished that the press already erased. */
            if (dial.answer.dropDeltasUntilResponseCreated) return;
            dial.answer.responseActive = false;
            dial.answer.endsWhenQueueDrains = true;
            this.#sendSpeakerAudio(dial, conversationId, append, runInBackground);
            return;

          case "response.done": {
            /* Every response ends here, audio or not — a pure function-call
             * response never sends output_audio.done, so without this the
             * NEXT press would cancel a response that no longer exists. */
            dial.answer.responseActive = false;
            /* The barged response is now FINAL — whether a press cancelled
             * it or the provider's own VAD did — so the deferred truncate
             * can no longer race the item's own finalization. */
            const pending = dial.pendingTruncate;
            if (pending !== null && dial.ready && dial.socket !== null) {
              dial.pendingTruncate = null;
              this.#sendControl(
                dial,
                {
                  type: "conversation.item.truncate",
                  item_id: pending.itemId,
                  content_index: pending.contentIndex,
                  audio_end_ms: pending.audioEndMs,
                },
                conversationId,
                append,
              );
              this.#sendHeardPrefixNote(dial, pending.audioEndMs, conversationId, append);
            }
            /* The floor is free; a hang-up waiting on the drain settles now. */
            this.#sendSpeakerAudio(dial, conversationId, append, runInBackground);
            return;
          }

          case "response.function_call_arguments.done": {
            /* Residue discipline, same as audio: a cancelled response's tool
             * call is an intent the user erased, and running it anyway is the
             * barge failing at the worst altitude — a side effect. */
            if (dial.answer.dropDeltasUntilResponseCreated) return;
            if (typeof grok.call_id !== "string") return;
            /* Unparseable arguments go through raw; the capability decides
             * what that means. */
            let modelArgs: unknown = grok.arguments;
            try {
              modelArgs = JSON.parse(String(grok.arguments ?? "{}"));
            } catch {
              /* Raw it is. */
            }
            this.#runTool(
              dial,
              grok.call_id,
              state.tools.find((tool) => tool.name === grok.name),
              modelArgs,
              conversationId,
              append,
              runInBackground,
            );
            return;
          }

          case "error":
            this.runInBackground(() =>
              append({
                type: "events.iterate.com/voice-agent/provider-error",
                payload: { conversationId, message: JSON.stringify(grok.error ?? grok) },
              }),
            );
            return;

          default:
            return;
        }
      });

      socket.addEventListener("close", () => {
        if (this.#dial !== dial) return;
        this.#dial = null;
        this.runInBackground(() =>
          append({
            type: "events.iterate.com/voice-agent/conversation-end-requested",
            idempotencyKey: this.idempotencyKey(`socket-closed:${conversationId}`),
            payload: { conversationId, reason: "Grok's socket closed" },
          }),
        );
      });

      /*
       * THE IDLE COUNTDOWN, in the same closure as the socket it will end —
       * a SELF-RESCHEDULING TICK CHAIN, not a loop. One background closure
       * that settles only when the call ends is indistinguishable from a
       * wedge to the facet keepalive's busy-refire detector: after ~15 quiet
       * minutes of a perfectly healthy call it would cross the detector's
       * threshold, spend spurious revival passes against a live incarnation,
       * and decay the alarm cadence toward its plateau — so a REAL eviction
       * during a long call would get its revival hours late. Each tick is
       * its own settling closure instead: one check, then hand the chain to
       * a fresh closure, so the keepalive sees progress every five seconds.
       * The chain dies naturally when the dial-identity fence fails.
       *
       * It compares two stamps from DIFFERENT clocks — the facet's now and
       * the stream's commit — which is only sound because both are wall-clock
       * milliseconds from Cloudflare's own clock and the deadline is a
       * minute. Anything tighter than that would need a single clock.
       */
      const idleTick = async (): Promise<void> => {
        await this.deps.sleep(IDLE_TICK_MS);
        if (this.#dial !== dial) return;
        const nowAtFacetMs = this.deps.nowAtFacetMs();
        /*
         * IDLE SINCE THE LAST THING THAT HAPPENED, whichever end it happened
         * at — and the second half of that is why this is a max rather than
         * a skip.
         *
         * The durable stamp only records the DEVICE's input, because that is
         * the only side leaving events, and a listener hearing out a
         * ninety-second answer sends nothing. Merely refusing to hang up
         * WHILE speaking is not enough: the stamp goes on ageing behind the
         * answer, so the moment the queue drains the clock is already past
         * the deadline and the call dies one tick later. Measured — a 64s
         * answer, then `conversation-ended` 1.1s after it finished, between
         * turns, with the listener about to speak.
         *
         * Finishing an answer is an event on this call as much as hearing one
         * is. `deviceBufferEmptyAtFacetMs` is when the device runs dry, so
         * while it is in the future this end is still talking, and once it
         * passes it is the moment this end stopped. Both readings are what
         * the deadline wants.
         *
         * In-memory ON PURPOSE: after an eviction there is no answer in
         * flight and nothing was said, so a revived incarnation falls back to
         * the durable stamp alone and the deadline still bites. Moving THAT
         * into memory is the thing that once let a keepalive restart the
         * minute for ever.
         */
        const lastActivityAtFacetMs = Math.max(
          this.#lastDeviceInputAtStreamMsMirror,
          dial.deviceBufferEmptyAtFacetMs,
        );
        if (nowAtFacetMs - lastActivityAtFacetMs < IDLE_TIMEOUT_MS) {
          this.runInBackground(idleTick);
          return;
        }
        /* Still holding audio it has not handed over yet: not idle by any
         * reading, whatever the clocks say. A queue held for a tentative
         * onset does not count — an onset nobody ever settles (a board that
         * died mid-blip) would otherwise wedge the deadline open for ever. */
        if (dial.speakerQueue.length > 0 && dial.tentativeOnset === null) {
          this.runInBackground(idleTick);
          return;
        }
        await append({
          type: "events.iterate.com/voice-agent/conversation-end-requested",
          idempotencyKey: this.idempotencyKey(`idle:${conversationId}`),
          payload: {
            conversationId,
            reason: `no input from the device for ${IDLE_TIMEOUT_MS / 1000}s`,
          },
        });
      };
      this.runInBackground(idleTick);
    });
  }

  /**
   * The provider's timeline, for instruments — WITHOUT the audio in it.
   *
   * This lane forwarded every message verbatim, `delta` included, which means
   * every answer went out twice: once cut up and paced on `spk-frame`, and
   * once again whole, in tens of kilobytes of base64 per chunk, hundreds of
   * chunks an answer, on a lane no client subscribes to. v1 learned this the
   * expensive way and strips it; v2 was written fresh and did not, so the
   * lesson had to be paid for a second time.
   *
   * What a reader of this lane actually wants is the TRANSITIONS — the edges
   * that diagnose a silent call, which is what proved a barge-in one
   * millisecond after `response.created` was cancelling four answers in six.
   * The audio's content is already on `spk-frame`. So the delta rides as its
   * LENGTH: the shape of the answer stays visible and the bytes go once.
   */
  #forwardProviderEvent(
    grok: Record<string, unknown>,
    providerEventType: string,
    conversationId: string,
    receivedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
  ): void {
    let body = grok;
    if (providerEventType === "response.output_audio.delta") {
      const { delta, ...rest } = grok;
      const base64 = typeof delta === "string" ? delta : "";
      /* DECODED length, not the base64 string's: the field says bytes and it
       * should mean the audio's bytes. */
      const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
      body = { ...rest, deltaBytes: Math.floor(base64.length / 4) * 3 - padding };
    }
    this.runInBackground(() =>
      append({
        type: "events.iterate.com/voice-agent/grok-event",
        payload: { ...body, conversationId, receivedAtFacetMs },
      }),
    );
  }

  /**
   * Commit the captured turn and ask for an answer — the two sends that a
   * client owning its own turns pays for, kept together so neither can be
   * forgotten alone.
   */
  #askForAnswer(socket: WebSocket): void {
    socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    socket.send(JSON.stringify({ type: "response.create" }));
  }

  /* ----------------------------------------------------------------- lanes */

  /**
   * Run one tool call the model made, off the frame path, and ALWAYS answer
   * it. A function call is a debt: a model that never hears an output waits
   * on it, so every path out — error and deadline included — sends exactly
   * one function_call_output. Silence is the one forbidden result.
   */
  #runTool(
    dial: Dial,
    callId: string,
    tool: z.infer<typeof VoiceTool> | undefined,
    modelArgs: unknown,
    conversationId: string,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgent2Contract>["runInBackground"],
  ): void {
    dial.openToolCallIds.add(callId);
    runInBackground(async () => {
      let output: string;
      if (tool === undefined) {
        output = JSON.stringify({ error: "no such tool" });
      } else if (tool.expression === undefined) {
        /* THE BASE CASE, NOT A REGISTRY: hanging up is one atomic append of
         * conversation-end-requested, deferred to the drain point so the
         * goodbye being spoken right now gets PLAYED, not cut. */
        dial.hangUpAfterAnswerDrains = "the model hung up";
        output = JSON.stringify({ status: "hanging up once this answer finishes playing" });
      } else {
        const expression = tool.expression;
        try {
          /* A sentinel loser, never a throwing one: the branch that loses the
           * race still settles later, and a floating rejection is a crash
           * nobody attributed. */
          const timedOut = Symbol("tool deadline");
          const work = this.deps.withProject(async (project) => {
            /* The platform's own walk (apps/os/src/itx/expression.ts):
             * reads pipeline, calls invoke. Intermediate stubs chain inside
             * this one session and die with its disposal. */
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
          const result = await Promise.race([
            work,
            this.deps.sleep(TOOL_RUN_DEADLINE_MS).then(() => timedOut as unknown),
          ]);
          if (result === timedOut) {
            void work.catch(() => {});
            throw new Error(`took longer than ${TOOL_RUN_DEADLINE_MS}ms`);
          }
          const json = JSON.stringify(result ?? { status: "done" });
          output =
            json.length > TOOL_OUTPUT_MAX_CHARS
              ? JSON.stringify({ truncated: json.slice(0, TOOL_OUTPUT_MAX_CHARS) })
              : json;
        } catch (error) {
          /* The model HEARS the failure; the follow-up below is what turns
           * "nothing happened" into it saying "that did not work, because…". */
          output = JSON.stringify({ error: String(error).slice(0, 300) });
        }
      }
      /* The fence every provider-lane completion wears: a re-dialed call is
       * a NEW session that never issued this call_id. */
      if (this.#dial !== dial) return;
      dial.openToolCallIds.delete(callId);
      this.#sendControl(
        dial,
        {
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output },
        },
        conversationId,
        append,
      );
      /* ONE follow-up, only when the floor is free: all parallel outputs in
       * (grok's documented contract), no response talking, no barge residue
       * pending — the press owns the floor it took. hang_up asks for nothing:
       * it is something the assistant DID, not something to talk about. */
      if (
        tool?.expression !== undefined &&
        dial.openToolCallIds.size === 0 &&
        !dial.answer.responseActive &&
        !dial.answer.dropDeltasUntilResponseCreated
      ) {
        this.#sendControl(dial, { type: "response.create" }, conversationId, append);
      }
    });
  }

  /**
   * Send one client control event AND record it on the `grok-event` lane as
   * `client.<type>` — the lane is the wire's flight recorder, and a recorder
   * that hears only one direction cannot explain an interruption gone wrong.
   */
  #sendControl(
    dial: Dial,
    message: Record<string, unknown>,
    conversationId: string,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
  ): void {
    if (dial.socket === null) return;
    dial.socket.send(JSON.stringify(message));
    const { item, ...rest } = message;
    this.runInBackground(() =>
      append({
        type: "events.iterate.com/voice-agent/grok-event",
        payload: {
          ...rest,
          type: `client.${String(message.type)}`,
          ...(item === undefined ? {} : { itemSummary: JSON.stringify(item).slice(0, 300) }),
          conversationId,
          receivedAtFacetMs: this.deps.nowAtFacetMs(),
        },
      }),
    );
  }

  /**
   * What the listener has HEARD of the answer, read off the pacer's own
   * schedule: everything handed to the device, minus what still sat unplayed
   * in its buffer — which a clear is about to throw away. The schedule
   * models the WORST-CASE lead, so this can only understate; the floor at
   * zero covers an answer that never started.
   */
  #heardMsFromSchedule(dial: Dial, nowAtFacetMs: number): number {
    const unplayedMs = Math.max(0, dial.deviceBufferEmptyAtFacetMs - nowAtFacetMs);
    return Math.max(0, Math.floor(dial.answer.sentMs - unplayedMs));
  }

  /**
   * Fix the model's memory of an answer the listener cut off.
   *
   * Cancels and clears stop the SOUND; this repairs the MEMORY. The
   * provider's conversation still holds every millisecond it GENERATED —
   * barged eight seconds into a count, the model claimed "26", the generated
   * frontier rather than the heard one. `conversation.item.truncate` at
   * heard-ms trims the item's audio AND transcript; the heard-prefix note
   * then restores what was actually heard, because truncation deletes the
   * transcript wholesale and a model asked "how far did you get" over
   * audio-only memory swings to "I never even started" (measured live).
   * One frame of slack (25 ms) so a fully-played answer is never
   * "truncated" to its own length by rounding.
   *
   * TWO SHAPES, by the response's state:
   *
   *   ACTIVE — the truncate must WAIT. Sent beside the cancellation it
   *   races the item's own finalization (observed live: the ack and the
   *   response's `done` shared a millisecond, and the model still
   *   remembered the full count). So it is armed on the dial and settled at
   *   the response's `response.done`, note included; the residue gate
   *   closes here too. What this method deliberately does NOT send is
   *   `response.cancel`: the press arm owns that (no provider cancels for a
   *   button), and the VAD arm must never send it — OpenAI's
   *   `interrupt_response` (pinned true in our session.update) already
   *   cancelled server-side at the onset, and grok errored on every
   *   VAD-triggered cancel tried.
   *
   *   SETTLED — truncate and note go immediately; nothing finalizes late.
   */
  #repairBargedAnswerMemory(
    dial: Dial,
    heardMs: number,
    conversationId: string,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
  ): void {
    if (!dial.ready || dial.socket === null) return;
    const wantsTruncate = dial.answer.itemId !== null && heardMs + 25 < dial.answer.receivedMs;
    if (dial.answer.responseActive) {
      dial.answer.responseActive = false;
      dial.answer.dropDeltasUntilResponseCreated = true;
      if (wantsTruncate) {
        dial.pendingTruncate = {
          itemId: dial.answer.itemId!,
          contentIndex: dial.answer.contentIndex,
          audioEndMs: heardMs,
        };
        dial.answer.itemId = null;
      }
      return;
    }
    if (wantsTruncate) {
      this.#sendControl(
        dial,
        {
          type: "conversation.item.truncate",
          item_id: dial.answer.itemId,
          content_index: dial.answer.contentIndex,
          audio_end_ms: heardMs,
        },
        conversationId,
        append,
      );
      dial.answer.itemId = null;
      this.#sendHeardPrefixNote(dial, heardMs, conversationId, append);
    }
  }

  /**
   * A tentative onset proved itself: a turn was committed, or a new answer
   * began. The retained tail dies now and the memory repair runs with the
   * heard-ms frozen at the onset's clear. No-op when nothing is held, which
   * is every commit outside a barge — so both confirming arms call this
   * unconditionally. The device needs no second clear (it was silenced at
   * the onset), except when a retraction let frames slip out in the
   * stopped-to-committed gap — and then #dropAnswerInFlight's watermark
   * sends exactly one.
   */
  #confirmTentativeOnset(
    dial: Dial,
    conversationId: string,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
  ): void {
    const onset = dial.tentativeOnset;
    if (onset === null) return;
    dial.tentativeOnset = null;
    this.#dropAnswerInFlight(dial, conversationId, this.deps.nowAtFacetMs(), append);
    /* An answer that died unheard must not mark an end: the drain marker
     * would tell the device a turn finished that the onset just erased. */
    dial.answer.endsWhenQueueDrains = false;
    this.#repairBargedAnswerMemory(dial, onset.heardMs, conversationId, append);
  }

  /**
   * Tell the model what the listener actually heard of its cut-off answer.
   *
   * Truncation deleted the item's transcript wholesale, and a model asked
   * "how far did you get" over audio-only memory swings to "I never
   * started" (measured live). The note carries the heard PREFIX — the
   * transcript cut at the barge's heard/received ratio, rounded down to a
   * word — so recall becomes exact instead of confabulated in either
   * direction. A system item: context, never speech.
   */
  #sendHeardPrefixNote(
    dial: Dial,
    heardMs: number,
    conversationId: string,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
  ): void {
    if (dial.socket === null || !dial.ready) return;
    const segments = dial.answer.transcript;
    dial.answer.transcript = [];
    const heardPrefix = segments
      .filter((segment) => segment.atAnswerAudioMs <= heardMs)
      .map((segment) => segment.text)
      .join("")
      .trim();
    if (heardPrefix === "") return;
    this.#sendControl(
      dial,
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                `The user interrupted your previous spoken reply. They heard only this much of it: ` +
                `"${heardPrefix}". Nothing after that was heard.`,
            },
          ],
        },
      },
      conversationId,
      append,
    );
  }

  /**
   * Throw away the answer being spoken, here and on the device, right now.
   *
   * THE FLOOR CHANGED HANDS, and every caller means the same thing by it:
   * every frame minted so far belongs to an answer nobody will hear.
   *
   * Grok's `turn_detection` has no `interrupt_response`, so detecting speech
   * does NOT cancel the answer being generated — and by the time it fires the
   * generation has usually finished anyway, which is why `response.cancel`
   * came back as an error every time it was tried. Nothing but us dropping our
   * own queue stops the audio.
   *
   * WHY THIS IS A METHOD AND NOT A CASE. It began as one arm of the provider
   * switch, reachable only from `speech_started` and `response.created` — and
   * in push-to-talk `turn_detection` is null, so the provider never sends
   * `speech_started` at all. The floor changed hands when the button went
   * down and the only thing that noticed was the next answer, seconds later.
   * Measured on a real call: the device kept playing a dead answer for the
   * whole of the press. The button is the third caller.
   *
   * A tentative onset takes only the DEVICE half — #clearDeviceSpeaker —
   * because until it commits or retracts, the local queue is evidence, not
   * a backlog.
   */
  #dropAnswerInFlight(
    dial: Dial,
    conversationId: string,
    decidedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
  ): void {
    dial.speakerQueue = [];
    dial.deviceBufferEmptyAtFacetMs = 0;
    this.#clearDeviceSpeaker(dial, conversationId, decidedAtFacetMs, append);
  }

  /**
   * Tell the device to empty its speaker, and touch nothing local.
   *
   * THE CLEAR RIDES ON A FRAME, and an empty one is still a frame. The device
   * is holding up to a head start of dead audio and has to be told NOW, not
   * when the next answer starts — which is a second and a half later,
   * measured. So the instruction goes out as a frame of its own with no audio
   * in it, carrying the next sequence number, and the whole of the device's
   * policy stays "play frames in order; clear first if the frame says to".
   *
   * Sending it as a separate KIND of event was the first cut's mistake in a
   * different costume: two lanes for one decision, and the one carrying the
   * clear can arrive behind the audio it invalidates. Riding a numbered frame,
   * it cannot — the device orders by sequence number and this one is higher
   * than every frame it cancels.
   */
  #clearDeviceSpeaker(
    dial: Dial,
    conversationId: string,
    decidedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
  ): void {
    const clearedThroughDeviceSpeakerFrameSeq = dial.lastDeviceSpeakerFrameSeq;
    /* Nothing minted since the last clear means nothing to clear: the repeat
     * blips of a jittery detector cost one append each, and this is where they
     * stop costing anything at all. */
    if (clearedThroughDeviceSpeakerFrameSeq <= dial.clearedThroughDeviceSpeakerFrameSeq) return;
    /* The clear frame gets a number of its own, and the watermark moves PAST
     * it — otherwise the next blip sees the clear frame as something new to
     * clear and the guard never closes. */
    const clearFrameSeq = ++dial.lastDeviceSpeakerFrameSeq;
    dial.clearedThroughDeviceSpeakerFrameSeq = clearFrameSeq;
    /* There used to be a durable speaker-flush record appended beside this —
     * "when was I interrupted" surviving the ephemeral lane. Nothing ever
     * read it: not a device, not a probe, not a debugging session. The
     * numbered clear frame IS the flush. */
    this.runInBackground(() =>
      append({
        type: "events.iterate.com/voice-agent/spk-frame",
        payload: {
          conversationId,
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
   * speaker buffer from overflowing. Audio plays at one second per second, so
   * a sender that runs at the same rate can never make the backlog grow: the
   * board drains exactly as fast as we fill it. What it holds is therefore
   * bounded by the head start we deliberately give it —
   * MAX_DEVICE_SPEAKER_BUFFER_BYTES, one constant, in the unit the board runs
   * out of, chosen rather than estimated.
   *
   * WHAT THIS REPLACED, because the difference is the point. The first version
   * kept a running guess at how full the device's buffer was, advancing it by
   * each frame's duration and correcting it whenever it fell behind. That is a
   * model of memory on another machine, on a clock we do not share, and it can
   * only ever be wrong in a direction nobody can measure. There is no model
   * here: `deviceBufferEmptyAtFacetMs` is a schedule this processor invented
   * and controls, and the device is never mentioned.
   *
   * The schedule is a DEADLINE rather than `sleep(FRAME_MS)` between sends,
   * because the append itself takes time — a fixed sleep would run slower than
   * real time by however long an append costs, and the board would run dry a
   * little more with every frame.
   */
  #sendSpeakerAudio(
    dial: Dial,
    conversationId: string,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgent2Contract>["runInBackground"],
  ): void {
    if (dial.sending) return;
    dial.sending = true;
    runInBackground(async () => {
      try {
        /*
         * ONE LOOP, THREE JOBS, AND IT EXITS ONLY WHEN NONE REMAINS. The
         * straight-line version — drain, then maybe mark, then maybe hang up
         * — had a window: while it awaited the end-marker append, `sending`
         * was still held, so a delta landing there queued with no pacer to
         * come, and a second `output_audio.done` re-raised the marker flag
         * with nobody left to consume it. The audio was stranded and the
         * stale flag fired `lastFrameOfAnswer` in the middle of the NEXT
         * answer. Looping back after every await is the fix: nothing lands
         * during an await that the next iteration does not see.
         */
        for (;;) {
          /* The dial this pacer belongs to is gone — a hang-up or a re-dial
           * owns the wire now, and its queue died with it. Stop, so the
           * release below frees only this dial's lock and the new dial's own
           * pacer runs unimpeded. */
          if (this.#dial !== dial) return;
          /* A tentative onset owns the floor: the queue is evidence held
           * for a verdict, not a backlog to pace out. The retraction or the
           * confirm restarts this loop. */
          if (dial.tentativeOnset !== null && !dial.tentativeOnset.retracted) return;
          if (dial.speakerQueue.length > 0) {
            const nowAtFacetMs = this.deps.nowAtFacetMs();
            /*
             * A DEADLINE IN THE PAST MEANS THE DEVICE RAN DRY WHILE WE WERE
             * AWAY, and the backlog cannot be less than nothing.
             *
             * Without this the model banks credit for silence the device never
             * had to play: thirty seconds between answers would "earn" 480 KB of
             * headroom, which is the firehose this whole lane exists to prevent.
             */
            if (dial.deviceBufferEmptyAtFacetMs < nowAtFacetMs) {
              dial.deviceBufferEmptyAtFacetMs = nowAtFacetMs;
            }
            /* PEEK, never shift: a clear arriving during the sleep below has to
             * be able to filter this frame out of the queue. */
            const frame = dial.speakerQueue[0]!;
            /*
             * THE WHOLE SAFETY PROOF, IN ONE INEQUALITY. A frame goes only when
             * what the device already holds, plus this frame, fits the budget —
             * so the backlog is never above it. Bytes rather than a frame count
             * because the tail of a Grok delta is a partial frame, and a count
             * would mis-size exactly that one.
             */
            const overflowBytes =
              (dial.deviceBufferEmptyAtFacetMs - nowAtFacetMs) * PCM16_BYTES_PER_MS +
              frame.length -
              MAX_DEVICE_SPEAKER_BACKLOG_BYTES;
            if (overflowBytes > 0) {
              /* Full. Wait exactly long enough for the overflow to play off, then
               * look again — the queue may be gone and the clock must be reread. */
              await this.deps.sleep(Math.ceil(overflowBytes / PCM16_BYTES_PER_MS));
              continue;
            }
            dial.speakerQueue.shift();
            /* The device runs dry this much later. Advanced from the DEADLINE
             * rather than from now, so the cost of an append is absorbed and the
             * average send rate equals the play rate. */
            dial.deviceBufferEmptyAtFacetMs += frame.length / PCM16_BYTES_PER_MS;
            dial.answer.sentMs += frame.length / PCM16_BYTES_PER_MS;
            const clearFirst = dial.clearSpeakerBufferBeforeNextFrame;
            dial.clearSpeakerBufferBeforeNextFrame = false;
            await append({
              type: "events.iterate.com/voice-agent/spk-frame",
              payload: {
                conversationId,
                deviceSpeakerFrameSeq: ++dial.lastDeviceSpeakerFrameSeq,
                pcm: bytesToBase64(frame),
                ...(clearFirst && { clearSpeakerBufferBeforeFrame: true }),
                sentAtFacetMs: nowAtFacetMs,
              },
            });
            continue;
          }
          /*
           * THE QUEUE IS EMPTY, so if the provider has finished, the device now
           * holds the whole answer and can be told so. Behind the drain rather
           * than beside it: that ordering is the guarantee — the marker cannot
           * overtake audio it is about, because there is none left.
           */
          if (dial.answer.endsWhenQueueDrains) {
            dial.answer.endsWhenQueueDrains = false;
            /* The tail a retracted onset resumed has now played WHOLE, so
             * there is nothing left for a late commit to repair — and its
             * frozen heard-ms is stale: truncating a fully-heard answer to
             * it would damage the very memory the repair protects. */
            dial.tentativeOnset = null;
            dial.lastDeviceSpeakerFrameSeq += 1;
            const clearFirst = dial.clearSpeakerBufferBeforeNextFrame;
            dial.clearSpeakerBufferBeforeNextFrame = false;
            await append({
              type: "events.iterate.com/voice-agent/spk-frame",
              payload: {
                conversationId,
                deviceSpeakerFrameSeq: dial.lastDeviceSpeakerFrameSeq,
                pcm: "",
                ...(clearFirst && { clearSpeakerBufferBeforeFrame: true }),
                lastFrameOfAnswer: true,
                sentAtFacetMs: this.deps.nowAtFacetMs(),
              },
            });
            continue;
          }
          /* THE MODEL HUNG UP, and the drain point is where that settles — the
           * same place lastFrameOfAnswer is decided, for the same reason: it is
           * where the answer is knowable. The device holds the whole goodbye;
           * the pacer's own deadline says when it finishes PLAYING. Sleep that
           * off, re-check (a press during playout un-decides it), then one
           * atomic append; the ordinary end-requested machinery does the rest.
           * A hang-up behind a still-ACTIVE response is not settleable yet —
           * `response.done` re-triggers the pacer and it settles then. */
          if (dial.hangUpAfterAnswerDrains !== null && !dial.answer.responseActive) {
            await this.deps.sleep(
              Math.max(0, dial.deviceBufferEmptyAtFacetMs - this.deps.nowAtFacetMs()),
            );
            if (this.#dial !== dial) return;
            const reason = dial.hangUpAfterAnswerDrains;
            if (reason !== null && dial.speakerQueue.length === 0) {
              dial.hangUpAfterAnswerDrains = null;
              await append({
                type: "events.iterate.com/voice-agent/conversation-end-requested",
                idempotencyKey: this.idempotencyKey(`hang-up:${conversationId}`),
                payload: { conversationId, reason },
              });
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

  /** Let the dial and everything hanging off it go. Safe to call twice. */
  #hangUp(): void {
    this.#micQueue = [];
    this.#turnEndedDuringHandshake = false;
    const dial = this.#dial;
    this.#dial = null;
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

export async function dialProviderSocket(
  provider: VoiceProvider,
  baseUrl: string | null,
  model: string,
): Promise<WebSocket | null> {
  const target = new URL(baseUrl ?? PROVIDERS[provider].url);
  target.searchParams.set("model", model);
  const headers: Record<string, string> = { Upgrade: "websocket" };
  /* The credential follows the HOST, never the flag: a test seam pointing at
   * a fake gets no Authorization header at all, whichever provider it fakes. */
  if (target.hostname === "api.x.ai" || target.hostname.endsWith(".x.ai")) {
    headers.Authorization = `Bearer getSecret("${XAI_SECRET}")`;
  }
  if (target.hostname === "api.openai.com") {
    headers.Authorization = `Bearer getSecret("${OPENAI_SECRET}")`;
  }
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

/*
 * INSTALLING THIS THING, AND WHY IT IS ITS OWN ENTRYPOINT.
 *
 * The first cut's `setupVoiceAgent` is four hundred lines because it also
 * derives a prompt from the project's live capabilities, installs it as an
 * agent brief, and proves the running processor folded THAT brief and not an
 * older one. This one has no tools, so it has no capabilities to describe, so
 * the prompt is just a string the caller passes — and the whole apparatus
 * collapses into: append the birth certificate, install the subscription, and
 * hold the platform's fold-through barrier until the facet has folded both.
 *
 * It lives beside the facet rather than importing the first cut's because the
 * two tracks must be able to move independently. Sharing the setup would make
 * every change to v1's prompt derivation a change to v2's install path, which
 * is the coupling this rewrite exists to be free of.
 */

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
    console.error("voice-agent2 RPC stub disposal failed", { error, label });
  }
}

/**
 * Where the loader finds this facet: this file, in the project's config repo.
 *
 * `voice-agent2-facet` rather than the first cut's `voice-agent-facet`, and
 * that distinction is load-bearing rather than cosmetic: the key names the
 * durable worker, so two tracks sharing it would be two classes claiming one
 * identity — and the point of this exercise is to run both at once and compare
 * them.
 */
function voiceAgent2FacetRef(streamPath: string) {
  return {
    className: "VoiceAgent2Facet",
    durableWorkerKey: "voice-agent2-facet",
    path: streamPath,
    source: {
      createWorker: {
        entryPoint: "voice-agent2.ts",
        files: { repoPath: "/repos/config", type: "repo" },
      },
    },
    type: "stateful",
  } satisfies StatefulDynamicWorkerRef;
}

/** How long setup's fold-through barrier waits. A cold facet build is most of it. */
const WARMUP_DEADLINE_MS = 90_000;

/** What setup needs to know to put this agent on a stream. */
export interface SetupVoiceAgent2Options {
  /** The conversation stream. A fresh /agents/voice2/* path is generated when omitted. */
  streamPath?: string;
  /**
   * Dial THIS instead of x.ai, for a deterministic test.
   *
   * NO CREDENTIAL FOLLOWS IT — see {@link dialProviderSocket}, where the rule is
   * that a host which is not x.ai gets no Authorization header at all.
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
  /** Tools the model may call: name/description/parameters go to the
   * provider; the itx expression is the run. No expression = hang_up. */
  tools?: z.input<typeof VoiceTool>[];
  /** Install the subscription under a fresh key even if an identical one exists. */
  reinstall?: boolean;
}

/** What setup did, in enough detail for a caller to print it. */
export interface SetupVoiceAgent2Result {
  streamPath: string;
  /** Setup's own clock: batch appended to fold-through proven. Cold build included. */
  warmMs: number;
}

export default class VoiceAgent2Entrypoint extends IterateWorkerEntrypoint {
  /**
   * Prove this guest is built, running, and can reach its own project.
   *
   * A dynamic worker is built lazily on the first call into it, so that first
   * call carries a cold build and a build failure surfaces in whatever the
   * caller happened to be doing. Having a call whose only job is to be the
   * first one means a caller can pay for the build deliberately.
   */
  async health(): Promise<{ ok: true; projectId: string; xaiSecretReady: boolean }> {
    const project = await this.itx;
    const projectId = await project.projectId;
    const xaiSecret = project.secrets.get(XAI_SECRET);
    try {
      const secret = await xaiSecret.__describe();
      try {
        return {
          ok: true,
          projectId,
          xaiSecretReady: secret.created === true && secret.hasMaterial === true,
        };
      } finally {
        disposeRpcStub(secret, "health secret description result");
      }
    } finally {
      disposeRpcStub(xaiSecret, "health secret");
    }
  }

  async setupVoiceAgent2(options: SetupVoiceAgent2Options = {}): Promise<SetupVoiceAgent2Result> {
    const streamPath = options.streamPath ?? `/agents/voice2/${crypto.randomUUID()}`;
    if (!streamPath.startsWith("/")) {
      throw new Error(
        `voice-agent2 streamPath must be absolute; received ${JSON.stringify(streamPath)}`,
      );
    }

    const project = await this.itx;
    const xaiSecret = project.secrets.get(XAI_SECRET);
    let xaiReady = false;
    try {
      const description = await xaiSecret.__describe();
      try {
        xaiReady = description.created === true && description.hasMaterial === true;
      } finally {
        disposeRpcStub(description, "setup secret description result");
      }
    } finally {
      disposeRpcStub(xaiSecret, "setup secret");
    }
    if (!xaiReady) {
      throw new Error(
        'voice-agent2 setup requires secret "/secrets/xai" with material. Create it with ' +
          'await itx.secrets.get("/secrets/xai").create({ egress: { urls: ["https://api.x.ai"] }, ' +
          'material: "<xAI API key>" }); then rerun. This agent never creates or copies credentials.',
      );
    }

    const stream = project.streams.get(streamPath);
    try {
      /*
       * BIRTH AND CONFIGURATION, SPLIT — the explicit-birth doctrine applied
       * to this agent at last. `created` is existence only, under a key with
       * nothing but the stream path in it: appended once for the life of the
       * stream, and a second setup run finds the key taken and appends
       * nothing, because a second birth is corruption rather than an update.
       *
       * The configuration is an ordinary event. Which provider to dial and
       * what to say the model is are per-stream settings that must survive
       * the eviction a per-call argument would not, so they ride `configured`
       * — keyed on content so a morning that alternates mock, real, mock,
       * real applies each switch. The first cut keyed its config on content
       * ALONE and by the second `real` the key was taken, nothing was
       * appended, and the fold still named a tunnel that had closed an hour
       * before.
       */
      const configPayload = {
        ...(options.providerBaseUrl === undefined
          ? {}
          : { providerBaseUrl: options.providerBaseUrl }),
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.providerModel === undefined ? {} : { providerModel: options.providerModel }),
        ...(options.providerVoice === undefined ? {} : { providerVoice: options.providerVoice }),
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        ...(options.clientTakesTurns === undefined
          ? {}
          : { clientTakesTurns: options.clientTakesTurns }),
        ...(options.tools === undefined ? {} : { tools: options.tools }),
      };
      /*
       * ONE IDENTITY FOR THIS SETUP, so the configuration is re-applied when
       * an earlier run already used its content key. The setup id is what
       * makes this an OCCURRENCE rather than a value.
       */
      const setupId = crypto.randomUUID();
      const subscriptionPayload = {
        name: VoiceAgent2Contract.slug,
        description: "Wake the voice-agent2 facet in this stream's own Durable Object.",
        /* DERIVED from the contract, never hand-written: delivery is this filter
         * INTERSECTED with `consumes`, so a type in one list and not the other is
         * silently never delivered, and two hand-maintained copies of one list
         * drift. Adding a type to `consumes` is now the whole change. */
        filter: { eventTypes: [...VoiceAgent2Contract.consumes] },
        receiver: {
          action: "facet-processor",
          source: { kind: "userspace", worker: voiceAgent2FacetRef(streamPath) },
        },
      };
      const subscriptionKeyPrefix = `voice-agent2/subscription:${streamPath}`;
      const committed = await stream.append(
        {
          type: "events.iterate.com/voice-agent/created",
          idempotencyKey: `voice-agent2/created:${streamPath}`,
          payload: {},
        },
        {
          type: "events.iterate.com/voice-agent/configured",
          idempotencyKey: `voice-agent2/configured:${streamPath}:${contentHash(configPayload)}:setup:${setupId}`,
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
      /* The batch's HIGHEST offset is the barrier target: an idempotent
       * re-append returns the ORIGINAL committed events, so a re-run of setup
       * waits on offsets long since folded and returns at once. */
      let setupBatchMaxOffset = 0;
      try {
        for (const event of committed) {
          setupBatchMaxOffset = Math.max(setupBatchMaxOffset, event.offset);
        }
      } finally {
        disposeRpcStub(committed, "setup stream append result");
      }

      /*
       * THE PLATFORM'S OWN BARRIER, where a token knock used to be.
       *
       * `waitUntilProcessed` resolves once the facet subscription has durably
       * folded through the batch above — forcing the same cold build the
       * knock forced, and proving strictly more than the echo proved: not
       * "someone answered" but "the fold has REACHED the birth certificate".
       * The knock (a warmup event the facet echoed back, token and colo
       * attached) dated from the pre-facet delivery lane, where an append
       * proved nothing about the processor behind it; the facet
       * subscription's barrier is precise even mid-connection, so the whole
       * anchored-offset dance dies with the two warmup events.
       *
       * ENFORCED by the throw inside the barrier's timeout, not reported:
       * setup's contract is "ready to hold a conversation", and a caller that
       * has to check a boolean will eventually forget to.
       */
      const warmStartedAt = Date.now();
      const subscription = stream.subscriptions.get(VoiceAgent2Contract.slug);
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
  async removeVoiceAgent2(options: { streamPath: string }): Promise<{ streamPath: string }> {
    const project = await this.itx;
    const stream = project.streams.get(options.streamPath);
    try {
      const removed = await stream.append({
        type: "events.iterate.com/stream/subscription-removed",
        idempotencyKey: `voice-agent2/subscription-removed:${options.streamPath}:${crypto.randomUUID()}`,
        payload: { name: VoiceAgent2Contract.slug },
      });
      disposeRpcStub(removed, "remove append result");
      return { streamPath: options.streamPath };
    } finally {
      disposeRpcStub(stream, "remove stream");
    }
  }
}

export class VoiceAgent2Facet extends StreamProcessorFacet {
  protected readonly recovery = true;
  protected createProcessor(deps: ProcessorHostDeps) {
    return new VoiceAgent2Processor({
      ...deps,
      nowAtFacetMs: () => Date.now(),
      /* Safe as a bare setTimeout BECAUSE of where it is awaited: every wait
       * here happens inside a `runInBackground` closure the keepalive holds, so
       * the object is up to receive it and there is an I/O context to append
       * from. */
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      dialProvider: (provider, baseUrl, model) => dialProviderSocket(provider, baseUrl, model),
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
