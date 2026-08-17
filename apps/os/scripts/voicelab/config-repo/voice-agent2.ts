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
 * THREE SEQUENCES, AND THEY ARE NOT INTERCHANGEABLE. Every count in this file
 * says which of the three it belongs to, because conflating them is how the
 * first cut lost track of what a flush was flushing:
 *
 *   `deviceMicFrameSeq`      device microphone -> facet -> Grok. Minted by the
 *                            DEVICE; the facet never renumbers it.
 *   `grokAudioDeltaSeq`      Grok -> facet. One per `response.output_audio.delta`
 *                            as the facet received it, counted per call.
 *   `deviceSpeakerFrameSeq`  facet -> device speaker. One per paced, mu-law
 *                            encoded chunk. A single Grok delta usually becomes
 *                            several of these, so the two counts diverge
 *                            immediately — which is exactly why a flush must
 *                            name this one and no other.
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
 *   `...AtGrokMs`     a stamp the PROVIDER put on its own event
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
 * a facet whose clock it has never seen — see `turn-timing`.
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
 * files, wired to the same events. This one runs a call — and stamps where
 * each turn's time went (`turn-timing`), because a lane nobody can attribute
 * is a lane nobody can fix.
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
    model: "gpt-realtime",
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
const GROK_SERVER_VAD = { type: "server_vad", threshold: 0.85, prefix_padding_ms: 333 } as const;

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
/* The only helpers in this file, and all three are pure functions over bytes. */

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

/**
 * Linear-interpolation PCM16 resampling, for the one provider that does not
 * speak this pipeline's 16 kHz. Linear costs a little treble against a
 * windowed-sinc kernel and nothing anybody hears on speech through these
 * speakers; what matters is that it is allocation-light and runs per frame.
 */
function resamplePcm16(bytes: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate) return bytes;
  const samples = Math.floor(bytes.byteLength / 2);
  if (samples === 0) return new Uint8Array(0);
  const source = new Int16Array(bytes.buffer, bytes.byteOffset, samples);
  const outLength = Math.max(1, Math.round((samples * toRate) / fromRate));
  const out = new Int16Array(outLength);
  for (let index = 0; index < outLength; index++) {
    const position = outLength === 1 ? 0 : (index * (samples - 1)) / (outLength - 1);
    const base = Math.floor(position);
    const fraction = position - base;
    const first = source[base] ?? 0;
    const second = source[base + 1] ?? first;
    out[index] = (first + (second - first) * fraction) | 0;
  }
  return new Uint8Array(out.buffer);
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
 * Everything that outlives the Durable Object holding the socket.
 *
 * Note what is NOT here: no queues, no byte counts, no "is speaking" flag.
 * Reduced state that depends on a buffer no restart can replay is a lie, and
 * every derived number kept beside its source is a chance for the two to
 * disagree.
 */
const VoiceState = z.object({
  /** Dial this instead of x.ai. Test seam; carries no credential. */
  grokBaseUrl: z.string().nullable().default(null),
  /** Which realtime voice provider this stream's calls dial. */
  provider: z.enum(["grok", "openai"]).default("grok"),
  /** Model and voice overrides; null takes the provider's default. */
  providerModel: z.string().nullable().default(null),
  providerVoice: z.string().nullable().default(null),
  /** What the model is told it is. Empty means Grok's own default. */
  grokInstructions: z.string().default(""),
  /** Which brief setup last marked current; the warm-up handshake answers it. */
  briefCurrent: z
    .strictObject({ setupId: z.string(), briefKey: z.string(), contentHash: z.string() })
    .nullable()
    .default(null),
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
  version: "3.0.0",
  description: "Runs a voice call in the stream's own Durable Object, one flush watermark deep.",
  stateSchema: VoiceState,
  events: {
    "events.iterate.com/voice-agent/created": {
      description: "The voice agent exists on this stream.",
      payloadSchema: z.strictObject({
        grokBaseUrl: z.string().optional(),
        provider: z.enum(["grok", "openai"]).optional(),
        providerModel: z.string().optional(),
        providerVoice: z.string().optional(),
        grokInstructions: z.string().optional(),
        clientTakesTurns: z.boolean().optional(),
      }),
    },
    "events.iterate.com/voice-agent/brief-current": {
      description: "Setup's statement of which brief is current.",
      payloadSchema: z.looseObject({
        setupId: z.string(),
        briefKey: z.string(),
        contentHash: z.string(),
      }),
    },
    "events.iterate.com/voice-agent/warmup": {
      description: "A readiness probe for this stream's processor. Starts nothing.",
      payloadSchema: z.looseObject({ token: z.string() }),
    },
    "events.iterate.com/voice-agent/warmup-ready": {
      description: "This facet is built, running, and knows its brief; echoes the token.",
      payloadSchema: z.looseObject({ token: z.string() }),
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
        /** The DEVICE's counter. The facet never renumbers it. */
        deviceMicFrameSeq: z.number().optional(),
        /** 16 kHz mono PCM16, base64. The only encoding this lane carries. */
        pcm: z.string(),
        /** The board's own uptime clock when it captured this frame. */
        capturedAtDeviceMs: z.number().optional(),
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
        /** Which Grok delta this chunk was cut from. Debugging, not ordering. */
        fromGrokAudioDeltaSeq: z.number(),
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
    /**
     * DURABLE, and it is the only part of the audio path that is.
     *
     * One per interruption rather than one per frame, so the volume is nothing;
     * and worth keeping because a revived incarnation that could not see this
     * would replay an answer the listener already talked over.
     */
    "events.iterate.com/voice-agent/speaker-flush": {
      description: "Every speaker frame at or below this sequence number is dead.",
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        clearedThroughDeviceSpeakerFrameSeq: z.number(),
        /** What took the floor: a Grok event type, or the device's own button. */
        reason: z.string(),
        /** Facet clock, at the moment the flush was decided. */
        decidedAtFacetMs: z.number(),
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
    /**
     * WHERE ONE TURN'S TIME WENT, and the only lane that can say.
     *
     * `grok-event` already carries every provider stamp — and every audio
     * delta with them, tens of kilobytes at a time. An instrument that
     * subscribes to it to learn four numbers doubles its own downlink and
     * inflates the very latency it is measuring. This is those four numbers
     * and nothing else, once per turn.
     *
     * ALL ON THE FACET'S CLOCK, which is what makes it usable from a laptop
     * whose clock is minutes off. A probe measures its own release-to-audio
     * total locally and subtracts the two provider terms below, both of which
     * are DURATIONS on one clock — so the skew cancels instead of being
     * estimated, and what is left is ours.
     */
    "events.iterate.com/voice-agent/turn-timing": {
      description: "One turn's stamps on the facet clock: end seen, commit, ack, first delta.",
      ...EPH,
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        /** The release reaching the facet. Everything before it is the network. */
        endSeenAtFacetMs: z.number(),
        /** Null when the turn ended before the provider handshake finished. */
        commitSentAtFacetMs: z.number().nullable(),
        /** The provider acknowledging the commit: one round trip from the colo. */
        committedAckAtFacetMs: z.number().nullable(),
        /** The answer's first byte. Ack to here is the model thinking. */
        firstDeltaAtFacetMs: z.number(),
        /** The turn's first capture, so delivery backlog is visible. */
        firstMicFrameAtFacetMs: z.number().nullable(),
        micFrames: z.number(),
        /** The longest silence between two frames: one stall, against drift. */
        maxMicFrameGapMs: z.number(),
        /**
         * How many frames had already arrived when that gap happened.
         *
         * SIZING A STALL DOES NOT LOCATE IT, and the two candidate causes make
         * opposite predictions. A stall at frame one or two is the delivery
         * lane WAKING UP — nothing has been sent for the length of the
         * previous answer, so the first frame pays for whatever went to sleep.
         * A stall in the middle is the lane failing to keep up while running,
         * which is a different bug with a different fix. One number tells them
         * apart; without it both stories fit every measurement.
         */
        maxMicFrameGapAfterFrames: z.number(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/voice-agent/created",
    "events.iterate.com/voice-agent/brief-current",
    "events.iterate.com/voice-agent/warmup",
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
    "events.iterate.com/voice-agent/warmup-ready",
    "events.iterate.com/voice-agent/call-started",
    "events.iterate.com/voice-agent/conversation-accepted",
    "events.iterate.com/voice-agent/conversation-end-requested",
    "events.iterate.com/voice-agent/conversation-ended",
    "events.iterate.com/voice-agent/provider-error",
    "events.iterate.com/voice-agent/spk-frame",
    "events.iterate.com/voice-agent/speaker-flush",
    "events.iterate.com/voice-agent/grok-event",
    "events.iterate.com/voice-agent/turn-timing",
  ],
});
export type VoiceAgent2Contract = typeof VoiceAgent2Contract;

/** The stamps a turn accumulates before it can be reported. See the contract. */
interface TurnTiming {
  firstMicFrameAtFacetMs: number | null;
  lastMicFrameAtFacetMs: number | null;
  micFrames: number;
  maxMicFrameGapMs: number;
  maxMicFrameGapAfterFrames: number;
  endSeenAtFacetMs: number | null;
  commitSentAtFacetMs: number | null;
  committedAckAtFacetMs: number | null;
  /** Reported once, when the answer's first byte lands. */
  reported: boolean;
}

const freshTurn = (): TurnTiming => ({
  firstMicFrameAtFacetMs: null,
  lastMicFrameAtFacetMs: null,
  micFrames: 0,
  maxMicFrameGapMs: 0,
  maxMicFrameGapAfterFrames: 0,
  endSeenAtFacetMs: null,
  commitSentAtFacetMs: null,
  committedAckAtFacetMs: null,
  reported: false,
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
  }
> {
  readonly contract = VoiceAgent2Contract;

  /* --------------------------------------------------------- runtime state */
  /* Every one of these dies with the incarnation on purpose. Anything that
   * must outlive an eviction is in the fold above. */

  /** Grok's socket, or null when this incarnation is not holding one. */
  #grokSocket: WebSocket | null = null;
  /** True once Grok's handshake completed and audio may flow. */
  #grokReady = false;
  /** One dial at a time: two caught-up deliveries must not open two sockets. */
  #dialInFlight = false;

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
  #speakerQueue: {
    fromGrokAudioDeltaSeq: number;
    pcm16: Uint8Array;
  }[] = [];
  /**
   * Capture that arrived before Grok's handshake finished, oldest first.
   *
   * Bytes and nothing else: `deviceMicFrameSeq` belongs to the device and is
   * never renumbered here, so holding a copy of it would be a field nobody
   * reads. Order in this array IS the order it was captured in.
   */
  #micQueue: Uint8Array[] = [];
  /**
   * The device finished its turn while the handshake was still in flight.
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
   * The turn in flight, for `turn-timing`. Never null; reset by the button.
   *
   * INSTRUMENTATION AND NOTHING ELSE — no decision in this file reads it. That
   * is deliberate: the measurement should not be able to change the thing it
   * measures, and a turn record that only ever grows and gets overwritten
   * cannot fail in a way that costs a caller an answer.
   */
  #turn: TurnTiming = freshTurn();

  /** Last sequence number minted on each lane, for this call. */
  #lastGrokAudioDeltaSeq = 0;
  #lastDeviceSpeakerFrameSeq = 0;
  /**
   * How far a clear has already been declared, so a jittery detector is free.
   *
   * Five `speech_started` in one answer was measured on real hardware. The
   * first moves this to the highest frame minted; the other four find nothing
   * new below it and cost one comparison each.
   */
  #clearedThroughDeviceSpeakerFrameSeq = 0;
  /**
   * The next frame out must tell the device to empty its speaker first.
   *
   * Set when a fresh socket opens, because whatever the board is still holding
   * belongs to an answer whose socket is gone. Consumed by the sender, so it
   * costs nothing when there is no audio to send — an idle call never issues a
   * clear nobody needed.
   */
  #clearSpeakerBufferBeforeNextFrame = false;
  /**
   * The provider has finished this answer; say so once the queue is empty.
   *
   * Deliberately NOT "mark the frame that happens to be last": that rule is
   * what made the flag losable. This is a question asked at the drain point,
   * where the answer is always knowable.
   */
  #answerEndsWhenQueueDrains = false;

  /**
   * When the device will run dry, on the facet clock. The only pacing state,
   * and the whole model of its memory:
   *
   *   heldBytes = max(0, #deviceBufferEmptyAtFacetMs - now) * PCM16_BYTES_PER_MS
   *
   * A deadline rather than a byte count beside a timestamp, because a deadline
   * drains implicitly with the clock. The pair would need a decay tick to stay
   * honest, and a decay tick that stops running is a field that silently lies.
   */
  #deviceBufferEmptyAtFacetMs = 0;
  /** One sender at a time. */
  #sending = false;

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
        return {
          ...state,
          grokBaseUrl: event.payload.grokBaseUrl ?? null,
          provider: event.payload.provider ?? "grok",
          providerModel: event.payload.providerModel ?? null,
          providerVoice: event.payload.providerVoice ?? null,
          grokInstructions: event.payload.grokInstructions ?? "",
          clientTakesTurns: event.payload.clientTakesTurns ?? false,
        };

      case "events.iterate.com/voice-agent/brief-current":
        return {
          ...state,
          briefCurrent: {
            setupId: event.payload.setupId,
            briefKey: event.payload.briefKey,
            contentHash: event.payload.contentHash,
          },
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
      this.#hangUp();
      void append({
        type: "events.iterate.com/voice-agent/conversation-ended",
        idempotencyKey: this.idempotencyKey(`ended:${owedCall.conversationId}`),
        payload: {
          conversationId: owedCall.conversationId,
          reason: owedCall.endRequested.reason,
        },
      });
    }
    if (owedCall !== null && owedCall.endRequested === null) {
      this.#openProviderConnection(owedCall.conversationId, state, append, runInBackground);
    }

    if (event === null) return;

    switch (event.type) {
      case "events.iterate.com/voice-agent/warmup": {
        /*
         * BEING HERE IS THE PROOF. A delivered warm-up means this class is
         * loaded and running in the stream's own Durable Object, so the only
         * thing left that can be missing is the brief — and that arrives on
         * this same subscription, in order, ahead of the token it answers.
         */
        if (state.briefCurrent === null) return;
        void append({
          type: "events.iterate.com/voice-agent/warmup-ready",
          idempotencyKey: this.idempotencyKey(`warmup:${event.payload.token}`),
          payload: { token: event.payload.token },
        });
        return;
      }

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
         * THE TURN'S STAMPS, taken before any branch below can return.
         *
         * Every arm of this case returns, and the interesting ones return
         * early — a frame held for a handshake, a frame that opens a call.
         * Stamping at the bottom would time only the turns that were already
         * easy. See `turn-timing`.
         */
        this.#stampTurn(event.type, micPcm16 !== null);
        /*
         * A CALL IS OPENED BY SOMEBODY TALKING, not by anybody asking for one.
         * The device has no way to know whether a call exists, and asking it to
         * say made two sources of truth for one fact.
         */
        /*
         * A TURN CAN END BEFORE THE LOG KNOWS A CALL BEGAN, and the fold is
         * several hundred milliseconds behind a person letting go of a button.
         * Recorded here as well as below because every branch under
         * `state.call === null` returns, and one of them is the ordinary case:
         * speak, release, all inside one round trip.
         */
        if (
          event.type === "events.iterate.com/voice-agent/ptt-end" &&
          state.clientTakesTurns &&
          !this.#grokReady
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
          const conversationId = `conv_${crypto.randomUUID()}`;
          this.#callRequested = true;
          void append({
            type: "events.iterate.com/voice-agent/call-started",
            idempotencyKey: this.idempotencyKey(`call:${conversationId}`),
            payload: { conversationId },
          });
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
         */
        if (event.type === "events.iterate.com/voice-agent/ptt-start") {
          this.#dropAnswerInFlight(
            state.call.conversationId,
            event.type,
            this.deps.nowAtFacetMs(),
            append,
          );
        }

        if (micPcm16 !== null) {
          const pcm = micPcm16;
          if (this.#grokReady && this.#grokSocket !== null) {
            /* Held frames resample at the flush; live ones resample here.
             * The queue itself stays 16 kHz so a re-dial to a DIFFERENT
             * provider never replays audio at the wrong rate. */
            this.#grokSocket.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: bytesToBase64(resamplePcm16(pcm, 16_000, PROVIDERS[state.provider].rate)),
              }),
            );
          } else if (this.#micQueue.length < MAX_HELD_MIC_FRAMES) {
            this.#micQueue.push(pcm);
          }
          return;
        }
        /* A client that owns its turns commits them; when Grok is listening,
         * its buttons — if it has any — say nothing, because server VAD on top
         * of a button answers halfway through a sentence. */
        if (event.type === "events.iterate.com/voice-agent/ptt-end" && state.clientTakesTurns) {
          if (this.#grokReady && this.#grokSocket !== null) {
            this.#askForAnswer(this.#grokSocket);
          } else {
            /* HELD, EXACTLY LIKE THE AUDIO IT BELONGS TO. This arm used to be
             * `&& this.#grokReady` on the condition above, so a turn that
             * ended before the handshake completed was not deferred, it was
             * DISCARDED — every frame of it delivered and none of it asked
             * about. See #turnEndedDuringHandshake. */
            this.#turnEndedDuringHandshake = true;
          }
        }
        return;
      }

      case "events.iterate.com/voice-agent/conversation-end-requested": {
        if (state.call === null || state.call.conversationId !== event.payload.conversationId) {
          return;
        }
        this.#hangUp();
        void append({
          type: "events.iterate.com/voice-agent/conversation-ended",
          idempotencyKey: this.idempotencyKey(`ended:${state.call.conversationId}`),
          payload: {
            conversationId: state.call.conversationId,
            reason: event.payload.reason,
          },
        });
        return;
      }

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
   * incarnation learns it owes a call nobody is dialling. `#dialInFlight`
   * and the socket check are what make the two callers safe together.
   */
  #openProviderConnection(
    conversationId: string,
    state: ProcessEventArgs<VoiceAgent2Contract>["state"],
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgent2Contract>["runInBackground"],
  ): void {
    if (this.#grokSocket !== null || this.#dialInFlight) return;
    this.#dialInFlight = true;
    const dialStartedAtFacetMs = this.deps.nowAtFacetMs();
    /* THIS DIAL'S OWN IDENTITY, for keys that must not collide with the
     * previous dial of the SAME call. A timestamp is not enough: a re-dial
     * inside the same millisecond — or on a test's virtual clock, which does
     * not move on its own — reuses it. */
    const dialId = crypto.randomUUID();
    runInBackground(async () => {
      const provider = PROVIDERS[state.provider];
      const socket = await this.deps
        .dialProvider(state.provider, state.grokBaseUrl, state.providerModel ?? provider.model)
        .finally(() => (this.#dialInFlight = false));
      if (socket === null) {
        void append({
          type: "events.iterate.com/voice-agent/conversation-end-requested",
          idempotencyKey: this.idempotencyKey(`dial-failed:${conversationId}`),
          payload: { conversationId, reason: "Grok refused the connection" },
        });
        return;
      }
      this.#grokSocket = socket;
      this.#grokReady = false;
      this.#speakerQueue = [];
      this.#lastGrokAudioDeltaSeq = 0;
      this.#deviceBufferEmptyAtFacetMs = 0;
      this.#clearedThroughDeviceSpeakerFrameSeq = 0;
      this.#lastDeviceSpeakerFrameSeq = 0;
      /*
       * A FRESH SOCKET STARTS BY EMPTYING THE DEVICE, which is what lets the
       * sequence restart at one.
       *
       * The device may still be holding frames from the incarnation that
       * died, numbered higher than the ones about to arrive. Rather than
       * remembering how high — a durable number, written to survive a thing
       * that cannot be survived — the first frame of the new session simply
       * says "clear". Whatever the board was holding belonged to an answer
       * whose socket is gone; nobody wants to hear the rest of it anyway.
       */
      this.#clearSpeakerBufferBeforeNextFrame = true;
      this.#answerEndsWhenQueueDrains = false;

      /*
       * THE THIRD SWITCH, AND WHY IT IS NOT A STREAM EVENT.
       *
       * Everything else in this file reaches `processEvent` by being
       * appended. Grok's messages do not, and the reason is measured rather
       * than stylistic: the ephemeral lane coalesces, delivering in clumps
       * seconds late. Routing an audio delta through it before acting on it
       * would put a second full stream round trip in front of the first word
       * of every answer. The provider's timeline is still appended for
       * instruments — just not waited for, and see `#forwardGrokEvent` for the
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
         * this check; the message listener is the one that needed it.
         */
        if (this.#grokSocket !== socket) return;
        if (typeof message.data !== "string") return;
        let grok: Record<string, unknown>;
        try {
          grok = JSON.parse(message.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const grokEventType = String(grok.type ?? "");
        const receivedAtFacetMs = this.deps.nowAtFacetMs();
        this.#forwardGrokEvent(grok, grokEventType, conversationId, receivedAtFacetMs, append);

        switch (grokEventType) {
          case "session.created":
            /* The one edge that makes us configure the session; miss it and
             * the handshake never completes and the call hangs, silently. */
            socket.send(
              JSON.stringify({
                type: "session.update",
                session: {
                  type: "realtime",
                  ...(state.grokInstructions === ""
                    ? {}
                    : { instructions: state.grokInstructions }),
                  audio: {
                    input: {
                      format: { type: "audio/pcm", rate: provider.rate },
                      turn_detection: state.clientTakesTurns ? null : GROK_SERVER_VAD,
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
            this.#grokReady = true;
            const heldMicFrames = this.#micQueue.length;
            for (const held of this.#micQueue) {
              socket.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: bytesToBase64(resamplePcm16(held, 16_000, provider.rate)),
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
            void append({
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
            });
            return;
          }

          /* The commit came back. One colo-to-provider round trip, and the
           * only term in a turn that is purely the network between them. */
          case "input_audio_buffer.committed":
            this.#turn.committedAckAtFacetMs = receivedAtFacetMs;
            return;

          case "input_audio_buffer.speech_started":
          case "response.created":
            this.#dropAnswerInFlight(conversationId, grokEventType, receivedAtFacetMs, append);
            return;

          case "response.output_audio.delta": {
            if (typeof grok.delta !== "string") return;
            /* The turn is over the moment its first byte exists, so the report
             * goes out before this delta is cut up and paced — which can take
             * as long as the answer is. */
            this.#reportTurnTiming(conversationId, receivedAtFacetMs, append);
            const fromGrokAudioDeltaSeq = ++this.#lastGrokAudioDeltaSeq;
            /*
             * CUT ONLY TO FIT THE DEVICE'S RECEIVE BUFFER. A delta is audio
             * of no particular length — measured against the real provider,
             * 0 of 77 in one answer were a multiple of anything — and the
             * board appends whatever bytes arrive to its speaker ring, so the
             * last piece of a delta being short costs nothing but one extra
             * append. Nothing is carried between deltas and nothing is padded.
             */
            /* The pipeline is 16 kHz from here to the speaker; a provider
             * that talks faster gets resampled at the door. */
            const pcm16 = resamplePcm16(base64ToBytes(grok.delta), provider.rate, 16_000);
            for (let cut = 0; cut < pcm16.length; cut += MAX_SPEAKER_PAYLOAD_BYTES) {
              this.#speakerQueue.push({
                fromGrokAudioDeltaSeq,
                pcm16: pcm16.subarray(cut, Math.min(cut + MAX_SPEAKER_PAYLOAD_BYTES, pcm16.length)),
              });
            }
            this.#sendSpeakerAudio(conversationId, append, runInBackground);
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
            this.#answerEndsWhenQueueDrains = true;
            this.#sendSpeakerAudio(conversationId, append, runInBackground);
            return;

          case "error":
            void append({
              type: "events.iterate.com/voice-agent/provider-error",
              payload: { conversationId, message: JSON.stringify(grok.error ?? grok) },
            });
            return;

          default:
            return;
        }
      });

      socket.addEventListener("close", () => {
        if (this.#grokSocket !== socket) return;
        this.#grokSocket = null;
        this.#grokReady = false;
        void append({
          type: "events.iterate.com/voice-agent/conversation-end-requested",
          idempotencyKey: this.idempotencyKey(`socket-closed:${conversationId}`),
          payload: { conversationId, reason: "Grok's socket closed" },
        });
      });

      /*
       * THE IDLE COUNTDOWN, in the same closure as the socket it will end.
       *
       * It compares two stamps from DIFFERENT clocks — the facet's now and
       * the stream's commit — which is only sound because both are wall-clock
       * milliseconds from Cloudflare's own clock and the deadline is a
       * minute. Anything tighter than that would need a single clock.
       */
      for (;;) {
        await this.deps.sleep(IDLE_TICK_MS);
        if (this.#grokSocket !== socket) return;
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
         * is. `#deviceBufferEmptyAtFacetMs` is when the device runs dry, so
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
          this.#deviceBufferEmptyAtFacetMs,
        );
        if (nowAtFacetMs - lastActivityAtFacetMs < IDLE_TIMEOUT_MS) continue;
        /* Still holding audio it has not handed over yet: not idle by any
         * reading, whatever the clocks say. */
        if (this.#speakerQueue.length > 0) continue;
        void append({
          type: "events.iterate.com/voice-agent/conversation-end-requested",
          idempotencyKey: this.idempotencyKey(`idle:${conversationId}`),
          payload: {
            conversationId,
            reason: `no input from the device for ${IDLE_TIMEOUT_MS / 1000}s`,
          },
        });
        return;
      }
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
   * The audio's content is already on `spk-frame`, and when its first byte
   * arrived is already on `turn-timing`. So the delta rides as its LENGTH: the
   * shape of the answer stays visible and the bytes go once.
   */
  #forwardGrokEvent(
    grok: Record<string, unknown>,
    grokEventType: string,
    conversationId: string,
    receivedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
  ): void {
    let body = grok;
    if (grokEventType === "response.output_audio.delta") {
      const { delta, ...rest } = grok;
      const base64 = typeof delta === "string" ? delta : "";
      /* DECODED length, not the base64 string's: the field says bytes and it
       * should mean the audio's bytes. */
      const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
      body = { ...rest, deltaBytes: Math.floor(base64.length / 4) * 3 - padding };
    }
    void append({
      type: "events.iterate.com/voice-agent/grok-event",
      payload: { ...body, conversationId, receivedAtFacetMs },
    });
  }

  /* ------------------------------------------------------------------ turn */

  /**
   * Note what this microphone event says about the turn in flight.
   *
   * The button opening a turn is the reset, not the answer arriving: a press
   * that interrupts an answer starts a turn whose old report has not been sent
   * and never will be, and holding on to it would attribute this turn's
   * release to the previous one's capture.
   */
  #stampTurn(eventType: string, carriesAudio: boolean): void {
    const atFacetMs = this.deps.nowAtFacetMs();
    if (eventType === "events.iterate.com/voice-agent/ptt-start") this.#turn = freshTurn();
    const turn = this.#turn;
    if (carriesAudio) {
      turn.micFrames += 1;
      if (turn.firstMicFrameAtFacetMs === null) turn.firstMicFrameAtFacetMs = atFacetMs;
      else if (turn.lastMicFrameAtFacetMs !== null) {
        const gapMs = atFacetMs - turn.lastMicFrameAtFacetMs;
        if (gapMs > turn.maxMicFrameGapMs) {
          turn.maxMicFrameGapMs = gapMs;
          turn.maxMicFrameGapAfterFrames = turn.micFrames - 1;
        }
      }
      turn.lastMicFrameAtFacetMs = atFacetMs;
      return;
    }
    if (eventType === "events.iterate.com/voice-agent/ptt-end") {
      turn.endSeenAtFacetMs = atFacetMs;
    }
  }

  /**
   * Commit the captured turn and ask for an answer — the two sends that a
   * client owning its own turns pays for, kept together so the stamp cannot
   * drift away from them.
   */
  #askForAnswer(socket: WebSocket): void {
    socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    socket.send(JSON.stringify({ type: "response.create" }));
    this.#turn.commitSentAtFacetMs = this.deps.nowAtFacetMs();
  }

  /** This turn's stamps, once, as the answer's first byte lands. */
  #reportTurnTiming(
    conversationId: string,
    firstDeltaAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
  ): void {
    const turn = this.#turn;
    /* A turn nobody ended is server VAD answering on its own; there is no
     * release to measure from and the report would be all nulls. */
    if (turn.reported || turn.endSeenAtFacetMs === null) return;
    turn.reported = true;
    void append({
      type: "events.iterate.com/voice-agent/turn-timing",
      payload: {
        conversationId,
        endSeenAtFacetMs: turn.endSeenAtFacetMs,
        commitSentAtFacetMs: turn.commitSentAtFacetMs,
        committedAckAtFacetMs: turn.committedAckAtFacetMs,
        firstDeltaAtFacetMs,
        firstMicFrameAtFacetMs: turn.firstMicFrameAtFacetMs,
        micFrames: turn.micFrames,
        maxMicFrameGapMs: Math.round(turn.maxMicFrameGapMs),
        maxMicFrameGapAfterFrames: turn.maxMicFrameGapAfterFrames,
      },
    });
  }

  /* ----------------------------------------------------------------- lanes */

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
   *
   * WHY THIS IS A METHOD AND NOT A CASE. It began as one arm of the provider
   * switch, reachable only from `speech_started` and `response.created` — and
   * in push-to-talk `turn_detection` is null, so the provider never sends
   * `speech_started` at all. The floor changed hands when the button went
   * down and the only thing that noticed was the next answer, seconds later.
   * Measured on a real call: the device kept playing a dead answer for the
   * whole of the press. The button is the third caller.
   */
  #dropAnswerInFlight(
    conversationId: string,
    reason: string,
    decidedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
  ): void {
    const clearedThroughDeviceSpeakerFrameSeq = this.#lastDeviceSpeakerFrameSeq;
    this.#speakerQueue = [];
    this.#deviceBufferEmptyAtFacetMs = 0;
    /* Nothing minted since the last clear means nothing to clear: the repeat
     * blips of a jittery detector cost one append each, and this is where they
     * stop costing anything at all. */
    if (clearedThroughDeviceSpeakerFrameSeq <= this.#clearedThroughDeviceSpeakerFrameSeq) return;
    /* The clear frame gets a number of its own, and the watermark moves PAST
     * it — otherwise the next blip sees the clear frame as something new to
     * clear and the guard never closes. */
    const clearFrameSeq = ++this.#lastDeviceSpeakerFrameSeq;
    this.#clearedThroughDeviceSpeakerFrameSeq = clearFrameSeq;
    void append(
      {
        type: "events.iterate.com/voice-agent/spk-frame",
        payload: {
          conversationId,
          deviceSpeakerFrameSeq: clearFrameSeq,
          fromGrokAudioDeltaSeq: this.#lastGrokAudioDeltaSeq,
          pcm: "",
          clearSpeakerBufferBeforeFrame: true,
          sentAtFacetMs: decidedAtFacetMs,
        },
      },
      {
        /* THE DURABLE RECORD, and it is only that. The device never reads
         * this; the frame above is the instruction. This is so "when was I
         * interrupted" survives the ephemeral lane, which forgets. */
        type: "events.iterate.com/voice-agent/speaker-flush",
        idempotencyKey: this.idempotencyKey(
          `flush:${conversationId}:${clearedThroughDeviceSpeakerFrameSeq}`,
        ),
        payload: {
          conversationId,
          clearedThroughDeviceSpeakerFrameSeq,
          reason,
          decidedAtFacetMs,
        },
      },
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
   * here: `#deviceBufferEmptyAtFacetMs` is a schedule this processor invented and
   * controls, and the device is never mentioned.
   *
   * The schedule is a DEADLINE rather than `sleep(FRAME_MS)` between sends,
   * because the append itself takes time — a fixed sleep would run slower than
   * real time by however long an append costs, and the board would run dry a
   * little more with every frame.
   */
  #sendSpeakerAudio(
    conversationId: string,
    append: ProcessEventArgs<VoiceAgent2Contract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgent2Contract>["runInBackground"],
  ): void {
    if (this.#sending) return;
    this.#sending = true;
    runInBackground(async () => {
      try {
        while (this.#speakerQueue.length > 0) {
          const nowAtFacetMs = this.deps.nowAtFacetMs();
          /*
           * A DEADLINE IN THE PAST MEANS THE DEVICE RAN DRY WHILE WE WERE AWAY,
           * and the backlog cannot be less than nothing.
           *
           * Without this the model banks credit for silence the device never
           * had to play: thirty seconds between answers would "earn" 480 KB of
           * headroom, which is the firehose this whole lane exists to prevent.
           */
          if (this.#deviceBufferEmptyAtFacetMs < nowAtFacetMs) {
            this.#deviceBufferEmptyAtFacetMs = nowAtFacetMs;
          }
          /* PEEK, never shift: a clear arriving during the sleep below has to
           * be able to filter this frame out of the queue. */
          const frame = this.#speakerQueue[0]!;
          /*
           * THE WHOLE SAFETY PROOF, IN ONE INEQUALITY. A frame goes only when
           * what the device already holds, plus this frame, fits the budget —
           * so the backlog is never above it. Bytes rather than a frame count
           * because the tail of a Grok delta is a partial frame, and a count
           * would mis-size exactly that one.
           */
          const overflowBytes =
            (this.#deviceBufferEmptyAtFacetMs - nowAtFacetMs) * PCM16_BYTES_PER_MS +
            frame.pcm16.length -
            MAX_DEVICE_SPEAKER_BACKLOG_BYTES;
          if (overflowBytes > 0) {
            /* Full. Wait exactly long enough for the overflow to play off, then
             * look again — the queue may be gone and the clock must be reread. */
            await this.deps.sleep(Math.ceil(overflowBytes / PCM16_BYTES_PER_MS));
            continue;
          }
          this.#speakerQueue.shift();
          /* The device runs dry this much later. Advanced from the DEADLINE
           * rather than from now, so the cost of an append is absorbed and the
           * average send rate equals the play rate. */
          this.#deviceBufferEmptyAtFacetMs += frame.pcm16.length / PCM16_BYTES_PER_MS;
          const clearFirst = this.#clearSpeakerBufferBeforeNextFrame;
          this.#clearSpeakerBufferBeforeNextFrame = false;
          await append({
            type: "events.iterate.com/voice-agent/spk-frame",
            payload: {
              conversationId,
              deviceSpeakerFrameSeq: ++this.#lastDeviceSpeakerFrameSeq,
              fromGrokAudioDeltaSeq: frame.fromGrokAudioDeltaSeq,
              pcm: bytesToBase64(frame.pcm16),
              ...(clearFirst ? { clearSpeakerBufferBeforeFrame: true } : {}),
              sentAtFacetMs: nowAtFacetMs,
            },
          });
        }
        /*
         * THE QUEUE IS EMPTY, so if the provider has finished, the device now
         * holds the whole answer and can be told so. After the loop rather than
         * inside it: that ordering is the guarantee — the marker cannot overtake
         * audio it is about, because there is none left.
         */
        if (this.#answerEndsWhenQueueDrains) {
          this.#answerEndsWhenQueueDrains = false;
          this.#lastDeviceSpeakerFrameSeq += 1;
          const clearFirst = this.#clearSpeakerBufferBeforeNextFrame;
          this.#clearSpeakerBufferBeforeNextFrame = false;
          await append({
            type: "events.iterate.com/voice-agent/spk-frame",
            payload: {
              conversationId,
              deviceSpeakerFrameSeq: this.#lastDeviceSpeakerFrameSeq,
              fromGrokAudioDeltaSeq: this.#lastGrokAudioDeltaSeq,
              pcm: "",
              ...(clearFirst ? { clearSpeakerBufferBeforeFrame: true } : {}),
              lastFrameOfAnswer: true,
              sentAtFacetMs: this.deps.nowAtFacetMs(),
            },
          });
        }
      } finally {
        this.#sending = false;
      }
    });
  }

  /** Let the socket and everything hanging off it go. Safe to call twice. */
  #hangUp(): void {
    this.#grokReady = false;
    this.#speakerQueue = [];
    this.#micQueue = [];
    this.#turnEndedDuringHandshake = false;
    this.#turn = freshTurn();
    const socket = this.#grokSocket;
    this.#grokSocket = null;
    try {
      socket?.close();
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
 * collapses into: append the birth certificate, install the subscription, say
 * which instructions are current, and knock to see if anyone is home.
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

/** How long to wait for the facet to answer the knock. A cold build is most of it. */
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
  grokBaseUrl?: string;
  /** Which realtime voice provider the birth certificate names. Default grok. */
  provider?: VoiceProvider;
  /** Model and voice overrides for that provider. */
  providerModel?: string;
  providerVoice?: string;
  /** What to tell the model it is. Empty leaves the provider's own default. */
  grokInstructions?: string;
  /**
   * This client segments its own turns with the push-to-talk verbs.
   *
   * Omitted means Grok listens, which is what every board wants. Say true only
   * for a client that really does own its turns — a terminal holding the space
   * bar — because on an open microphone it means Grok is never told a turn
   * ended, and the call goes silent with nothing logged.
   */
  clientTakesTurns?: boolean;
  /** Install the subscription under a fresh key even if an identical one exists. */
  reinstall?: boolean;
}

/** What setup did, in enough detail for a caller to print it. */
export interface SetupVoiceAgent2Result {
  streamPath: string;
  /** Facet clock: append the token, get the echo back. Cold build included. */
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
       * THE BIRTH CERTIFICATE, keyed on its own content.
       *
       * Which provider to dial and what to say the model is are per-stream
       * configuration, and they belong in an event because they have to survive
       * the eviction that a per-call argument would not. Keyed on content so a
       * morning that alternates mock, real, mock, real applies each switch —
       * the first cut keyed this on content ALONE and by the second `real` the
       * key was taken, nothing was appended, and the fold still named a tunnel
       * that had closed an hour before.
       */
      const birthPayload = {
        ...(options.grokBaseUrl === undefined ? {} : { grokBaseUrl: options.grokBaseUrl }),
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.providerModel === undefined ? {} : { providerModel: options.providerModel }),
        ...(options.providerVoice === undefined ? {} : { providerVoice: options.providerVoice }),
        ...(options.grokInstructions === undefined
          ? {}
          : { grokInstructions: options.grokInstructions }),
        ...(options.clientTakesTurns === undefined
          ? {}
          : { clientTakesTurns: options.clientTakesTurns }),
      };
      /*
       * ONE IDENTITY FOR THIS SETUP, so the birth certificate is re-applied when
       * an earlier run already used its content key. The setup id is what makes
       * this an OCCURRENCE rather than a value.
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
      const events = await stream.append(
        {
          type: "events.iterate.com/voice-agent/created",
          idempotencyKey: `voice-agent2/created:${streamPath}:${contentHash(birthPayload)}:setup:${setupId}`,
          payload: birthPayload,
        },
        {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: options.reinstall
            ? `${subscriptionKeyPrefix}:reinstall:${crypto.randomUUID()}`
            : `${subscriptionKeyPrefix}:${contentHash(subscriptionPayload)}`,
          payload: subscriptionPayload,
        },
        /*
         * WHICH INSTRUCTIONS ARE IN FORCE, and it is the readiness gate.
         *
         * The processor will not answer a warm-up token until it has folded one
         * of these, which is what makes the handshake prove more than "the class
         * loaded": delivery is ordered, so an echo means this event was folded
         * first. It is the same marker the first cut uses to name an agent
         * brief; here there is no brief, and the honest content is a digest of
         * the instructions this call just installed.
         */
        {
          type: "events.iterate.com/voice-agent/brief-current",
          idempotencyKey: `voice-agent2/brief-current:${setupId}`,
          payload: {
            setupId,
            briefKey: `voice-agent2/instructions:${contentHash(options.grokInstructions ?? "")}`,
            contentHash: contentHash(options.grokInstructions ?? ""),
          },
        },
      );
      disposeRpcStub(events, "setup stream append result");

      /*
       * THE KNOCK, AND THE WAIT STARTS BEHIND IT.
       *
       * `waitForEvent` with no `afterOffset` watches from the head it finds when
       * it opens, which is after this append has returned — and by then a warm
       * facet has already answered. That cost most of a day on the first cut:
       * `warmup` and `warmup-ready` 196ms apart, both on the stream, while setup
       * sat out its full 90-second deadline reporting that nobody was home.
       * Anchoring one offset behind the token's own commit makes the answer
       * impossible to miss and costs nothing when the facet really is cold.
       */
      const token = crypto.randomUUID();
      const warmStartedAt = Date.now();
      const warmupAppend = await stream.append({
        type: "events.iterate.com/voice-agent/warmup",
        payload: { token },
      });
      let waitAfterOffset = 0;
      try {
        const committed = warmupAppend.at(0);
        waitAfterOffset = committed === undefined ? 0 : committed.offset - 1;
      } finally {
        disposeRpcStub(warmupAppend, "warm-up append result");
      }
      const answer = await stream.waitForEvent({
        afterOffset: waitAfterOffset,
        eventTypes: ["events.iterate.com/voice-agent/warmup-ready"],
        predicate: (event) => (event.payload as { token?: string } | null)?.token === token,
        timeoutMs: WARMUP_DEADLINE_MS,
      });
      disposeRpcStub(answer, "warm-up wait result");
      /* ENFORCED by the throw inside waitForEvent's timeout, not reported:
       * setup's contract is "ready to hold a conversation", and a caller that
       * has to check a boolean will eventually forget to. */
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
    });
  }
}
