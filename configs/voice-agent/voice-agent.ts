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
 * WHAT IT DELIBERATELY DOES NOT DO: no head gestures, and no mouth of its
 * own — the face lives in face.ts as a pure mechanism this file only feeds
 * from four thin call sites. This one runs a call. (There was a
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
import { createFace } from "./face.ts";

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
 * certificate selects is not an adapter layer, it is five values: where to
 * dial, which model, which voice, the PCM rate (OpenAI speaks 24 kHz where
 * this pipeline is 16; the two resample sites below are that difference's
 * entire cost), and which verb repairs a barged answer's memory.
 *
 * `truncates`: whether `conversation.item.truncate` actually works. The
 * clone claim breaks exactly here, and silently — probed live 2026-08-18:
 * grok returns no `conversation.item.truncated` ack, no error, nothing,
 * even for a bogus item id (where OpenAI errors), and the barged
 * full-count item stayed whole in context with the model recalling all
 * of it. `conversation.item.delete` was probed as the fallback and is
 * HALF-implemented: it acks for client-created items but answers "Item
 * not found" for the assistant's own response items — the only ones a
 * barge needs gone — twelve seconds after grok itself minted the id. So
 * on grok there is NO wire verb that repairs a barged answer's memory;
 * the heard-prefix note is the entire repair, and "how far did I get"
 * recall stays wrong there until xAI fixes either verb.
 *
 * `cancelsOnVadOnset`: whether the provider kills a STREAMING response
 * ITSELF the moment its VAD detects speech. On openai it does —
 * server_vad's `interrupt_response`, pinned true in our session.update —
 * so a mid-stream onset there means the tail is dead for certain. On grok
 * NOTHING cancels server-side: its turn_detection has no
 * `interrupt_response`, and a client `response.cancel` drew an error every
 * time a VAD-triggered one was tried. The barge machinery branches on this
 * fact: an onset on a provider that cancelled server-side is destructive;
 * on one that did not, it is only ever a tentative hold.
 */
const PROVIDERS: Record<
  VoiceProvider,
  {
    url: string;
    model: string;
    voice: string;
    rate: number;
    truncates: boolean;
    cancelsOnVadOnset: boolean;
  }
> = {
  grok: {
    url: "https://api.x.ai/v1/realtime",
    model: "grok-voice-think-fast-2.0",
    voice: "eve",
    rate: 16_000,
    truncates: false,
    cancelsOnVadOnset: false,
  },
  openai: {
    url: "https://api.openai.com/v1/realtime",
    /* The bare `gpt-realtime` alias stays on the ORIGINAL 2025 GA family
     * for ever; the successors ship under new names. Proven through the
     * barge/truncate/note gauntlet 2026-08-18 before becoming the default. */
    model: "gpt-realtime-2.1",
    voice: "marin",
    rate: 24_000,
    truncates: true,
    cancelsOnVadOnset: true,
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

/**
 * How a 16 kHz provider's delta is cut WITHOUT decoding it: the largest
 * multiple of 3 under the payload ceiling, sliced off the delta's own
 * base64. A multiple of 3 because every 4-character base64 group encodes 3
 * whole bytes — so an interior slice of a group-aligned string is itself
 * valid base64 and the device decodes it with no help — and 3,198 happens
 * to be even, so no sample is split either. Derived, not chosen: the
 * ceiling moves, this follows. (The decode-everything path still cuts at
 * the ceiling itself; only the identity path slices strings.)
 */
const IDENTITY_SLICE_BYTES = Math.floor(MAX_SPEAKER_PAYLOAD_BYTES / 3) * 3;
const IDENTITY_SLICE_B64_CHARS = (IDENTITY_SLICE_BYTES / 3) * 4;

/** 16 kHz mono PCM16: two bytes per sample, sixteen samples per millisecond. */
const PCM16_BYTES_PER_MS = 32;

/**
 * How far the board's speaker cone runs behind the pacer's schedule. The
 * schedule starts a frame's clock the moment it is handed to the stream;
 * the cone plays it later by delivery latency, the ~90 ms I2S DMA ring,
 * and the player's start-up fill. NOT the naive 300 ms prefill sum: the
 * bridge bursts an answer's opening at wire speed ("reached as fast as
 * the wire allows", voice_loop.c on SPEAKER_PREFILL_BYTES), so the
 * prefill contributes only its fill-time at burst rate — tens of ms.
 * Calibrated with the interject-recall probe against its 3/s count
 * cadence: recall must land within one counted number of the interrupt
 * without undershooting. #heardMsFromSchedule subtracts it, because
 * everything downstream of that method ("what did the listener hear")
 * means the cone, not the hand-over: uncorrected, post-barge recall ran
 * a consistent +2-3 counted numbers ahead of where the interrupt landed.
 */
const DEVICE_START_LAG_MS = 150;

/** No input from the device for this long and the call is over. Exported
 * for the tests that drive it — a re-declared copy passes silently the day
 * the two diverge, and this value has already moved once. */
export const IDLE_TIMEOUT_MS = 60_000;

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
 * How long after a dial failure before anything may dial again.
 *
 * Without it, a provider outage against an open-mic board is unbounded
 * churn: dial fails, the ended obituary folds, and the very next of the
 * board's fifty frames a second mints a NEW conversation and dials again —
 * call-started/end-requested/ended appended forever at fold-round-trip
 * cadence. Five seconds turns an outage into a dozen tidy attempts a
 * minute; the press after recovery still connects in one.
 */
const DIAL_RETRY_COOLDOWN_MS = 5_000;

/**
 * How long the provider gets from socket adoption to `session.updated`.
 *
 * Nothing else bounds this gap, and an open-mic call that never becomes
 * ready is SILENT FOREVER: mic frames keep the idle stamp fresh, so the
 * sixty-second backstop can never fire — the one wedge the idle deadline
 * cannot see. The concrete way in is a certificate `turnDetection` carrying
 * keys the provider chokes on without an error event (the certificate is
 * loose by design). Measured handshakes run ~1-1.4 s; fifteen seconds is
 * generous to a slow provider and still ends the wedge while somebody is
 * standing there.
 */
const HANDSHAKE_DEADLINE_MS = 15_000;

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
 * How much conversation the fold remembers, and so how much a fresh provider
 * session is briefed with. Turns beyond the newest TRANSCRIPT_MAX_TURNS fall
 * off the front; a single turn longer than TRANSCRIPT_TURN_MAX_CHARS is kept
 * head-first, because the head of an answer is what identifies it. Both
 * bounds exist because this rides the durable fold and the session
 * instructions — an unbounded recap is a session.update that one long story
 * makes undeliverable.
 */
const TRANSCRIPT_MAX_TURNS = 20;
const TRANSCRIPT_TURN_MAX_CHARS = 600;

/** How many colleague notes the fold keeps for the reconnect briefing, and
 * how much of each. Same reasoning as the transcript bounds. */
const COLLEAGUE_NOTES_MAX = 4;
const COLLEAGUE_NOTE_MAX_CHARS = 600;

/** One recap entry, as the fold keeps it. */
interface TranscriptTurn {
  role: "listener" | "assistant";
  text: string;
}

/**
 * The recap a fresh provider session is briefed with. A re-dial mid-stream is
 * the NORMAL case, not the exception — the idle deadline ends any call whose
 * listener waits quietly for a minute — and without this every reconnect was
 * a stranger answering the phone (measured on prd, 2026-08-26).
 */
function transcriptRecap(transcript: TranscriptTurn[]): string {
  return [
    "This call RESUMES an earlier conversation on the same line. The reconnect is " +
      "invisible to the listener — do not greet them afresh, do not ask them to repeat " +
      "themselves, and keep any thread that is still open. Said so far, oldest first:",
    ...transcript.map((turn) => `${turn.role === "assistant" ? "You" : "Listener"}: ${turn.text}`),
  ].join("\n");
}

/**
 * The whisper the live session hears, built from the FOLDED status so it
 * always carries both halves the frontend should know: the lifecycle phase
 * ("running code") AND the colleague's own words ("Sweeping March refunds").
 * A failed script brings its error along, because "say so, don't invent"
 * needs the truth on hand. Null when the fold has nothing yet — a
 * waitingFor-only flip is bookkeeping, not news.
 */
function colleagueStatusWhisper(
  status: { activity: string | null; phase: string | null; failure: string | null } | null,
): string | null {
  if (status === null) return null;
  const line = [status.phase, status.activity].filter(Boolean).join(" — ");
  if (line === "") return null;
  return `[backend status: ${line}${status.failure ? ` (${status.failure})` : ""}]`;
}

/**
 * The floor between unprompted spoken status lines. Statuses whisper freely
 * (context is cheap); SPEECH is rationed — a colleague mid-task narrates
 * every few seconds, and a call that repeats each one back is a ticker, not
 * an assistant.
 */
const SPOKEN_STATUS_MIN_GAP_MS = 15_000;

/**
 * How the colleague's stream reads as status, applied by the copy-to-stream
 * subscription ON THE SOURCE — the input is the source event whole, so the
 * expression branches on its type. The colleague's own summary narration
 * passes through; the model/script lifecycle becomes the same phases the OS
 * web UI renders ("writing code", "running code"); and a failed script keeps
 * a bounded slice of its error, which is what lets the voice say something
 * went wrong instead of inventing an explanation for the delay.
 */
/** Bump when the status subscription's filter or transform changes — see
 * the keyed append at the install site. */
const COLLEAGUE_STATUS_SUBSCRIPTION_REV = 4;

const COLLEAGUE_STATUS_TRANSFORM = [
  'type = "events.iterate.com/agents/web-message-sent"',
  '? { "type": "events.iterate.com/voice-agent/colleague-note",',
  '    "payload": { "text": payload.message } }',
  ': { "type": "events.iterate.com/voice-agent/colleague-status", "payload":',
  '    type = "events.iterate.com/agent/summary-updated"',
  '      ? { "activity": payload.activity, "title": payload.title, "waitingFor": payload.waitingFor }',
  '    : type = "events.iterate.com/agent/llm-request-requested"',
  '      ? { "phase": "writing code" }',
  '    : type = "events.iterate.com/capability-host/script-run-started"',
  '      ? { "phase": "running code" }',
  '    : payload.settlement.status = "failed"',
  '      ? { "phase": "a script failed", "failure": $substring($string(payload.settlement.error), 0, 200) }',
  '      : { "phase": "finished running code" } }',
].join("\n");

/**
 * THE CONVERSATION, ONTO THE COLLEAGUE'S STREAM. Both sides of the call —
 * the provider's transcription of the listener and its own transcript of
 * each answer — land on the colleague's stream as model-visible context
 * items, so the backend READS the conversation instead of being briefed
 * second-hand, the chat thread keeps a durable record of what was said,
 * and a later text conversation continues from the call.
 *
 * Role `developer`, not `user`, deliberately: user-role items participate
 * in turn accounting (queued messages, the working row) and a transcript
 * is testimony, not a prompt. `dont-trigger-request` for the same reason —
 * the fast half owns the conversation; the note lane is what asks the
 * backend to act. The actor names this voice stream, which is also what
 * keeps developer-role precedence through the platform's trust demotion
 * (agent-authored developer items keep their role).
 *
 * Installed by SETUP, not the facet: the first cut had #ensureColleagueLink
 * append it from processEvent, the deployed platform rejected the payload
 * (schema drift the facet cannot see), and the swallowed error took the
 * colleague brief down with it — measured on prd, one silent evening.
 * Setup's batch surfaces a refusal as a failed setup, and setup already
 * owns this stream's subscriptions. Content-hash keyed like the facet
 * subscription beside it.
 *
 * No `condition` on the filter, deliberately: deployed platforms reject
 * unknown filter keys, and both transcript append sites already skip empty
 * turns.
 */
function colleagueTranscriptSubscription(streamPath: string, colleaguePath: string) {
  return {
    name: "voice-frontend-transcript",
    description: "Land the call's transcript on the colleague's stream as context.",
    filter: {
      eventTypes: [
        "events.iterate.com/voice-agent/utterance-transcript",
        "events.iterate.com/voice-agent/answer-transcript",
      ],
    },
    receiver: {
      action: "copy-to-stream",
      receivingStreamPath: colleaguePath,
      jsonataTransform: colleagueTranscriptTransform(streamPath),
      delivery: { start: "now", onFailingEvent: "halt" },
    },
  };
}

/**
 * Where a stream's colleague lives. The certificate wins: a `colleaguePath`
 * names an EXISTING agent — a chat — as the backend (the "call any chat"
 * mode). Otherwise the voice stream's own path is re-rooted under
 * `/agents/voice-notes/`, a pure function of the path, so every
 * conversation on the stream — and every incarnation — reaches the SAME
 * desk, and a person who knows the call stream can type the colleague's
 * path from memory. The common `/agents/` prefix is folded rather than
 * repeated (`/agents/voice/x` → `/agents/voice-notes/voice/x`). Shared by
 * the facet (notes, the colleague-side link) and setup (the transcript
 * subscription's target).
 */
export function colleaguePathForStream(streamPath: string, certificatePath: string | null): string {
  if (certificatePath !== null) return certificatePath;
  const suffix = streamPath.startsWith("/agents/")
    ? streamPath.slice("/agents/".length)
    : streamPath.slice(1);
  return `/agents/voice-notes/${suffix}`;
}

function colleagueTranscriptTransform(voiceStreamPath: string): string {
  return [
    '{ "type": "events.iterate.com/agents/context-added",',
    '  "payload": {',
    '    "content": (type = "events.iterate.com/voice-agent/utterance-transcript"',
    '      ? "[voice call — the person said] "',
    "      : payload.cancelled = true",
    '        ? "[voice call — you said, interrupted partway] "',
    '        : "[voice call — you said] ") & payload.text,',
    '    "role": "developer",',
    `    "actor": { "type": "agent", "path": ${JSON.stringify(voiceStreamPath)} },`,
    '    "llmRequestPolicy": { "behaviour": "dont-trigger-request" }',
    "  } }",
  ].join("\n");
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
 * THINKING, FAST AND SLOW — the v1 back-office framing on v2 plumbing.
 *
 * The voice model is a mouth, a pair of ears and about 200ms of judgement;
 * anything that needs reading a repo, calling a tool chain, or being RIGHT
 * belongs to a text model with no clock on it. `note_to_self` is the seam:
 * the note goes as a fire-and-forget message to a full agent minted on its
 * own `/agents/voice-notes/...` stream — ONE COLLEAGUE PER VOICE STREAM,
 * its memory shared by every conversation the stream ever holds — and
 * EVERY chat message that agent ever sends comes back through the same
 * copy-to-stream subscription as its statuses, as a durable
 * `colleague-note` event on this stream.
 *
 * REPLIES ARRIVE AS EVENTS THROUGH THE SUBSCRIPTION, NOT ask(). It was
 * ask() — append the note, wait for the agent's next chat reply, 180s
 * deadline — and one real conversation showed every failure mode at once (prd, 2026-08-26 evening): asks
 * resolve by ORDER, so two pending notes were both answered by whichever
 * reply came first; a reply after the deadline resolved nothing; and an
 * UNSOLICITED backend message — "here are the verified results", sent with
 * no ask outstanding — vanished entirely, leaving the voice truthfully
 * saying "the status says results were delivered but I never received
 * them". A durable event has none of those failure modes: no deadline, no
 * correlation, nothing lost to eviction — and a note that lands between
 * calls is folded and briefed into the next session.
 *
 * PER STREAM, NOT PER CONVERSATION. It was per conversation, and one real
 * call proved that wrong (prd, 2026-08-26): the idle deadline manufactures
 * reconnects, each reconnect minted an amnesiac colleague, and "what's
 * going on?" went to an agent that had never heard the question — which
 * went spelunking through the platform instead of answering. Meanwhile the
 * first colleague finished the actual answer into a conversation that no
 * longer existed. One colleague per stream means the follow-up lands on
 * the desk that holds the context.
 * ======================================================================== */

/** The tool itself, injected when the certificate says `colleague` — never
 * part of `state.tools`, so no certificate can shadow or redefine it. */
const NOTE_TO_SELF_TOOL: z.infer<typeof VoiceTool> = {
  name: "note_to_self",
  description:
    "Write a note to your backend — the same assistant thinking carefully, with tools, files " +
    "and time. Use it for anything that needs looking up, working out, or doing properly. Keep " +
    "talking after you send it; the answer arrives later as a bracketed note, out of order or " +
    "not at all, and until it does you speak from what you already know.",
  parameters: {
    type: "object",
    properties: {
      note: {
        type: "string",
        description: "The note, in plain language: what you need and why.",
      },
    },
    required: ["note"],
  },
};

/**
 * What the fast half is told about the arrangement. Adapted from v1's three
 * load-bearing paragraphs: without the keep-talking instruction a voice
 * model handed an asynchronous tool goes silent waiting, which sounds
 * exactly like a dropped call; without the backend framing it treats the
 * first note that arrives as the answer to whatever it asked last; and
 * without being told it is not the judge of its own limits, it declines.
 *
 * TRANSPARENT ON PURPOSE, where v1 hid the machinery. The secrecy rule
 * ("never mention notes, halves, or colleagues") met the status whispers
 * and lost: a model forbidden to mention its backend rounded every status
 * it knew down to "I'm working on it", and a model that could not admit a
 * delay invented an explanation for one (both observed live, 2026-08-26).
 * The person may know there is a backend; what they must never get is a
 * made-up story.
 */
const FAST_HALF_INSTRUCTIONS = [
  "You are the realtime voice frontend of one assistant. You have a backend — the same",
  "assistant thinking carefully, with tools, files and time — reached through note_to_self.",
  "Anything that needs looking up, working out, remembering, or doing properly: send a note,",
  "say you've sent it to your backend, and keep the conversation going. Never go silent",
  "waiting for a reply, and never refuse a request because a voice cannot do it — your",
  "backend usually can.",
  "",
  "Be transparent about the arrangement — it is fine to talk about your backend when",
  "relevant. Bracketed [backend status: …] lines are ground truth about what it is doing",
  "right now: when asked about progress, relay the latest one plainly ('it's running the",
  "code now'). If no status has arrived yet, say the work just started. If a status says",
  "something failed or stalled, SAY SO — never invent an explanation for a delay or a",
  "result you have not seen.",
  "",
  "Sometimes you get the floor right after a status arrives, with no question pending.",
  "That is your chance to keep the person in the loop — use judgement. If the status is",
  "news worth hearing ('running the code now', 'that script failed'), say it in ONE short",
  "sentence, then stop. If it adds nothing the person would care about, a couple of words",
  "or nothing at all is better than filler. Never pad, never speculate past the status,",
  "and never let progress commentary delay a real answer: if the answer itself has",
  "arrived, deliver that instead.",
  "",
  "You can send follow-up notes at ANY time — to nudge, refine, add detail, or cancel.",
  "Nudge WITHOUT being asked: if the person is waiting and the statuses have gone quiet,",
  "or say the work finished but no note has arrived, send something like 'the person is",
  "waiting — send whatever you have so far'. When the person questions or corrects",
  "something, still pass the substance along in the note — your backend can read a",
  "transcript of this conversation, but it arrives with a delay and nobody rereads a",
  "transcript before acting, so 'the person doubts X because Y' beats 'the person",
  "disagrees'.",
  "",
  "Backend replies arrive as bracketed notes, late, out of order, or not at all. Relay",
  "them faithfully — summarize when that serves the moment, and read one out in full,",
  "word for word, whenever the person wants the details or asks you to repeat something.",
  "If one contradicts something you already said, correct yourself plainly.",
].join("\n");

/**
 * What the careful half is told at birth, as a system context item under a
 * stable key. Trimmed from v1's BACK_OFFICE_BRIEF: the activity narration
 * and the speechPolicy plumbing are gone because v0's only return lane is
 * the chat reply, which is exactly what `ask()` resolves with.
 *
 * THE REPLY CHANNEL IS SPELLED OUT MECHANICALLY, and the platform's own
 * reply-routing label is explicitly countermanded, because a real colleague
 * followed that label off a cliff (prd, 2026-08-26): every agent-sourced
 * message arrives stamped "To reply to /agents/voice/…: await
 * itx.agents.get(…).message(text)" — but the sender here is a facet, not an
 * agent, so `.message()` fails "has not been created", and a resourceful
 * model repaired that by CREATING an agent on the live call stream and
 * delivering the answer to it. Two text models then exchanged the answer
 * politely while the human heard nothing. The only wire that reaches the
 * voice is `itx.chat.sendMessage` — it emits the web-message-sent event the
 * facet's `ask()` is waiting on — and the brief now says exactly that,
 * exactly once per rule: what to call, what to never call, and why.
 */
const COLLEAGUE_BRIEF = [
  "You are the backend of ONE assistant. The frontend is a voice talking to a person out",
  "loud, and your chat replies HERE, ON THIS STREAM, are read back to it mid-conversation",
  "and spoken aloud. The person knows the assistant has a backend, so no pretence is",
  "needed — but you are still the same assistant, not a second person: write in its own",
  "first person — 'I checked the calendar and Thursday is free' — never 'tell them",
  "that…'.",
  "",
  "HOW TO REPLY — this exact call, and nothing else:",
  '  await itx.chat.sendMessage("…")',
  "Notes arrive stamped with a routing line like 'To reply to /agents/voice/…: await",
  "itx.agents.get(…).message(text)'. That line is WRONG on this stream — the sender is",
  "the voice call's machinery, not an agent. Calling .message() on it fails; calling",
  ".create() on it plants a rogue agent on the live call and breaks it. Never touch",
  "/agents/voice/… paths. Your chat reply here is the entire wire.",
  "",
  "Reply when you have something worth saying: an answer, a partial answer while you keep",
  "working, a correction, or a question back. Reply EARLY — a quick 'still working on it'",
  "chat message is heard; silent thoroughness is not. Send as many chat messages as you",
  "like: every one reaches the voice as its own note, whether or not anybody asked.",
  "",
  "A transcript of the call lands here as it happens — bracketed '[voice call — …]'",
  "context lines, both sides. Read it for what the person actually said and meant; do not",
  "reply to transcript lines directly (the voice is already answering them), only to",
  "notes.",
  "",
  "Everything you send will be READ OUT LOUD, so write to be spoken: two or three",
  "sentences of plain language, no lists, no URLs, no code. Lead with the point. Work with",
  "your tools as much as you like — but the words that reach the person are only ever your",
  "chat reply. (Between calls, replies on this stream are read on screen as usual — plain",
  "spoken prose reads fine there too.)",
].join("\n");

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

/**
 * Decoded byte length of a base64 string, WITHOUT decoding it — how the
 * identity paths (a 16 kHz provider feeding a 16 kHz pipeline) do all their
 * byte arithmetic on audio they never decode. Also what puts `deltaBytes`
 * on the mirror lane: the field says bytes and it means the audio's bytes,
 * not the base64 string's length, which is a third longer.
 */
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length / 4) * 3 - padding;
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
  provider: z.enum(["grok", "openai"]).default("openai"),
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
  /**
   * The provider's own `turn_detection` object, VERBATIM, for open-mic
   * streams that want their VAD tuned per stream — a quieter room wants a
   * lower threshold, a deliberate speaker a longer silence, the OpenAI-app
   * feel wants `semantic_vad`. Loose and provider-shaped on purpose: the
   * knobs are the provider's vocabulary (`threshold`,
   * `silence_duration_ms`, `eagerness`, …), they differ per dialect, and a
   * certificate that re-modelled them would gatekeep every new one. Null
   * takes this file's measured default (SERVER_VAD plus the openai pins).
   * Ignored entirely under `clientTakesTurns` — a button owns its turns
   * and the session gets `turn_detection: null` regardless.
   */
  turnDetection: z.looseObject({ type: z.string() }).nullable().default(null),
  /**
   * Classify the answer's audio into mouth shapes and publish the newest one
   * in the runtime bag, where a face-rendering board's 10 Hz poll reads it.
   * Certificate data because it is a fact about the CLIENT (does anything
   * render a mouth?), and because on a 16 kHz-native provider the classifier
   * costs the one delta decode the identity path otherwise never pays.
   */
  visemes: z.boolean().default(false),
  /**
   * Thinking, fast and slow. The voice model is a mouth, a pair of ears and
   * about 200ms of judgement; with this on it gets a `note_to_self` tool
   * that writes to the careful half — a full LLM agent minted on its own
   * `/agents/voice-notes/...` stream, ONE PER VOICE STREAM, whose chat
   * replies are read back into the call as bracketed notes. The v1
   * back-office framing, on v2 plumbing.
   *
   * ON BY DEFAULT: a voice that cannot leave itself a note is a mouth with
   * no desk, and every stream that shipped without the flag turned out to
   * be a stream somebody expected to have it. Refusing takes an explicit
   * `colleague: false` on the certificate.
   */
  colleague: z.boolean().default(true),
  /**
   * WHICH desk. Null derives the private `/agents/voice-notes/...` path
   * from this stream's own (the 12.0.0 arrangement); a path here makes an
   * EXISTING agent the colleague instead — the "call any chat" mode, where
   * the chat's agent is the backend, its replies are spoken into the call,
   * and the call's transcript lands on its stream. Certificate data
   * because it is a fact about the relationship, not the call.
   */
  colleaguePath: z.string().nullable().default(null),
  /**
   * Greet on pickup: when the handshake completes, the model speaks FIRST —
   * "hi" (or "hi again", which falls out of the transcript recap naturally)
   * — instead of waiting for a turn. Made for push-to-talk clients whose
   * ringing UX promises somebody on the other end; off by default because
   * the boards' open-mic rooms did not ask to be greeted.
   */
  greeting: z.boolean().default(false),
  /** Tools the model may call — see {@link VoiceTool}. */
  tools: z.array(VoiceTool).default([]),
  /**
   * The rolling recap: the newest finished turns, in words, both sides.
   * Folded from the durable transcript events and briefed into every fresh
   * provider session, so a re-dial resumes the conversation instead of
   * greeting the listener as a stranger. Bounded twice (turns kept, chars
   * per turn) because it rides the fold and the session instructions.
   */
  transcript: z
    .array(z.strictObject({ role: z.enum(["listener", "assistant"]), text: z.string() }))
    .default([]),
  /**
   * The colleague's latest self-reported status, folded from the forwarded
   * `colleague-status` events. `waitingFor` null means mid-task — the state
   * in which a fresh session's briefing warns that a note is still being
   * worked; "user_input" means the desk is idle.
   */
  colleagueStatus: z
    .strictObject({
      /** The colleague's own words, from its summary narration. */
      activity: z.string().nullable(),
      /** The lifecycle stage ("writing code", "running code", …). At least
       * one of activity/phase is always non-null — a status carrying
       * neither is never folded. */
      phase: z.string().nullable(),
      /** A failed script's error, kept so a reconnect's briefing can say
       * WHAT failed — the live whisper already carries it. */
      failure: z.string().nullable(),
      waitingFor: z.string().nullable(),
    })
    .nullable()
    .default(null),
  /**
   * The newest colleague notes, bounded, for the reconnect briefing: a note
   * that lands between calls (the idle deadline makes that the COMMON case
   * for slow work) would otherwise be spoken to nobody and forgotten. Some
   * may already have been relayed — the transcript recap shows what was
   * actually said, and the briefing says so.
   */
  colleagueNotes: z.array(z.strictObject({ text: z.string() })).default([]),
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

export const VoiceAgentContract = defineProcessorContract({
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
  /* 7.0.0: the certificate can carry the provider's own `turn_detection`
   * object verbatim (`turnDetection`), so open-mic VAD is tuned per stream
   * instead of per deploy. Clean break as ever. */
  /* 8.0.0: the face returns — `visemes` on the certificate classifies the
   * answer's audio into mouth shapes and publishes the newest in the
   * runtime bag, where the boards' existing 10 Hz poll has been reading
   * nothing since v1. */
  /* 9.0.0: thinking fast and slow returns — `colleague` on the certificate
   * arms `note_to_self`, which mints a fresh agent stream per conversation
   * and reads its chat replies back into the call. Clean break as ever. */
  /* 10.0.0: the colleague is the default — an absent `colleague` on
   * `configured` now means ON. Every stream reinstalled without the flag
   * turned out to be one somebody expected to have it; opting out takes an
   * explicit `colleague: false`. Clean break as ever. */
  /* 11.0.0: openai is the default provider — an absent `provider` on
   * `configured` now means openai. Grok's realtime lane has been down for
   * days and every stream anyone actually talks to names openai; the
   * default should be the provider that answers. Clean break as ever. */
  /* 12.0.0: one colleague per STREAM, not per conversation — the note agent
   * lives at a path derived from the voice stream's own, keeps its memory
   * across reconnects, and its late replies are spoken into whichever call
   * is live. Per-conversation colleagues at `/agents/voice-notes/<convId>`
   * are abandoned in place, not migrated. Clean break as ever. */
  /* 13.0.0: the conversation leaves a durable transcript — one event per
   * finished turn per side — and the fold keeps a bounded recap that briefs
   * every fresh provider session, so the reconnect the idle deadline
   * manufactures no longer wipes the fast half's memory. Clean break as
   * ever. */
  /* 14.0.0: the colleague's progress reaches the call — the mint installs a
   * copy-to-stream subscription that transforms the colleague's
   * agent/summary-updated feed into `colleague-status` events on this
   * stream; the fold keeps the latest, the live session hears about changes
   * as quiet context items, and the reconnect briefing can say a note is
   * still being worked (which is what stops re-asks). Streams installed
   * before this bump get the new delivery filter on their next setup run.
   * Clean break as ever. */
  /* 15.0.0: the status grows up and the machinery comes out of hiding. The
   * forwarding covers the model/script lifecycle too (`phase`: the OS UI's
   * "writing code" / "running code", plus failed scripts WITH their error),
   * the facet appends an opening status the moment a note is dispatched (the
   * colleague's first narration is 30-90s out), and the fast half is briefed
   * to be openly transparent about its backend — relay statuses, admit
   * failures, never invent an explanation for a delay. Clean break as
   * ever. */
  /* 16.0.0: replies arrive as events through the copy-to-stream
   * subscription, not ask(). Every chat message the colleague sends is
   * forwarded as a durable `colleague-note`
   * event — solicited or not, no deadline, no order-matching, nothing lost
   * to eviction — read into whichever call is live and folded (bounded) for
   * the reconnect briefing. ask()'s three observed loss modes (order-mixed
   * resolution, deadline expiry, unsolicited messages vanishing) go with
   * it. The fast half may nudge and forward the person's pushback without
   * being asked, and may read notes out verbatim. Clean break as ever. */
  /* 17.0.0: `greeting` on the certificate — a call that "rings" should say
   * hi when it picks up. On session.updated the facet plants a system item
   * and asks for one response; the transcript recap makes it "hi again" on
   * a stream that has history. Clean break as ever. */
  /* 18.0.0: `colleagueStatus.failure` joins the fold (a reconnect's briefing
   * should say WHAT failed). A required field on a strict schema means a
   * persisted 17.0.0 fold no longer parses — the major bump is what tells
   * the runner to re-reduce instead. Clean break as ever. */
  /* 19.0.0: the colleague can be ANY agent, and the arrangement grows both
   * ways. `colleaguePath` on the certificate points the frontend/backend
   * split at an existing agent (a chat) instead of a minted
   * `/agents/voice-notes/...` desk; the link is established at call start,
   * not first note, and setup installs a transcript lane — the call's
   * utterance/answer transcripts land on the colleague's stream as
   * developer context, so the backend reads the conversation. Whispers
   * carry BOTH the lifecycle phase and the colleague's own words, and a
   * newsworthy status (its words changed, or a failure) draws one
   * response.create when the floor is free — the frontend may SAY a short
   * status line instead of only knowing it. Clean break as ever. */
  version: "19.0.0",
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
        turnDetection: z.looseObject({ type: z.string() }).optional(),
        visemes: z.boolean().optional(),
        colleague: z.boolean().optional(),
        /** Point the colleague arrangement at an EXISTING agent's stream
         * instead of the derived voice-notes path — see the fold field. */
        colleaguePath: z.string().optional(),
        /** Speak first when a call connects — see the fold field. */
        greeting: z.boolean().optional(),
        tools: z.array(VoiceTool).optional(),
      }),
    },
    /*
     * THE DEVICE'S HALF, and it is three verbs: the button went down, here is
     * audio, the button came up. Whether a call exists, what it is called and
     * when it ends are the server's, because the server is the only side that
     * can know them.
     */
    /*
     * DURABLE, alone among the device's three verbs. The opening press is
     * the one event whose loss strands a human: measured on preview, the
     * first touch of an idle stream resets its Durable Object, an ephemeral
     * press dies with the old incarnation, and the caller waits out the
     * device's 3s retry in silence. Durable, the rebuilt facet's catch-up
     * mints the call itself. One append per press is nothing; mic-frame and
     * ptt-end stay ephemeral because losing them costs a turn, not a call.
     */
    "events.iterate.com/voice-agent/ptt-start": {
      description: "The user began speaking. Opens a call if one is not already up.",
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
     * THE DURABLE TRANSCRIPT — what was actually said, in words, one event
     * per finished turn per side. Everything else on this stream is either
     * ephemeral (audio, the mirrored provider events) or lifecycle, so until these a
     * conversation left no readable record and a re-dialled provider session
     * started with total amnesia: the reconnect the idle deadline
     * manufactures every time a listener waits quietly erased the whole
     * conversation from the fast half's head (measured on prd, 2026-08-26 —
     * "what's going on?" after a reconnect drew a fresh greeting). The fold
     * keeps a bounded recap of these and every new session is briefed with
     * it, so a reconnect is invisible to the listener — and an instrument or
     * an eval can read off the stream what the voice actually said.
     */
    "events.iterate.com/voice-agent/utterance-transcript": {
      description: "The provider's transcription of one finished listener turn.",
      payloadSchema: z.looseObject({ conversationId: z.string(), text: z.string() }),
    },
    "events.iterate.com/voice-agent/answer-transcript": {
      description:
        "The provider's own transcript of one finished answer. `cancelled` marks an answer " +
        "the listener barged; its text is what was GENERATED, not necessarily what was heard.",
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        text: z.string(),
        cancelled: z.boolean().optional(),
      }),
    },

    /*
     * THE COLLEAGUE'S OWN NARRATION, forwarded. Every agent is required to
     * append `agent/summary-updated` beside its work — the same feed the web
     * UI renders as the pending status — and the colleague's copy of it is
     * transformed onto this stream by the copy-to-stream subscription the
     * link installs (see #ensureColleagueLink). Nobody polls anybody: statuses
     * arrive only when the colleague actually does something. The fast half
     * reads them silently (a quiet context item, never a spoken
     * announcement), so "what's it doing?" gets "it's running the numbers"
     * instead of vamping — and a reconnect's briefing can say a note is
     * still being worked, which is what stops the re-ask duplication.
     */
    "events.iterate.com/voice-agent/colleague-status": {
      description:
        "One change of the colleague's self-reported status, copied (transformed) from its " +
        'stream\'s agent/summary-updated feed. `waitingFor` of "user_input" means idle.',
      payloadSchema: z.looseObject({
        activity: z.string().optional(),
        title: z.string().optional(),
        waitingFor: z.string().nullable().optional(),
        /** Lifecycle-derived stage — "writing code", "running code",
         * "a script failed" — the OS UI's vocabulary, from the transform. */
        phase: z.string().optional(),
        /** A failed script's error, bounded by the transform. */
        failure: z.string().optional(),
        /** Whisper-only: never draws a spoken status line. Worn by the
         * facet's own opening status — the model just SAID it sent the
         * note; announcing the dispatch back at it is an echo. */
        quiet: z.boolean().optional(),
      }),
    },
    "events.iterate.com/voice-agent/colleague-note": {
      description:
        "One chat message from the colleague, copied (transformed) from its stream's " +
        "web-message-sent feed — this is how every reply reaches the call. Durable, ordered, uncorrelated: every " +
        "message the colleague ever sends arrives here, solicited or not.",
      payloadSchema: z.looseObject({ text: z.string() }),
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
    /* Consumed so the fold sees its own appends and the recap survives an
     * eviction — processEvent has no arm for them on purpose. */
    "events.iterate.com/voice-agent/utterance-transcript",
    "events.iterate.com/voice-agent/answer-transcript",
    /* Appended by the copy-to-stream subscription on the colleague's stream
     * — and once per note by this processor (the opening status). Consumed
     * for the fold and the quiet injection. */
    "events.iterate.com/voice-agent/colleague-status",
    "events.iterate.com/voice-agent/colleague-note",
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
    "events.iterate.com/voice-agent/utterance-transcript",
    "events.iterate.com/voice-agent/answer-transcript",
    "events.iterate.com/voice-agent/colleague-status",
    "events.iterate.com/voice-agent/spk-frame",
    "events.iterate.com/voice-agent/grok-event",
  ],
});
export type VoiceAgentContract = typeof VoiceAgentContract;

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
   * Where the answer is in its life — one field, three states, where two
   * booleans used to leave the fourth combination representable.
   *
   *   "streaming"  between `response.created` and the response finishing —
   *                the precondition for `response.cancel` meaning anything.
   *                Without the gate, every ordinary press (no answer
   *                playing, which is most of them) would draw a "nothing to
   *                cancel" error event from the provider.
   *
   *   "cancelled"  a barge killed the active response; its remaining audio
   *                and tool calls are dead. The cancellation is asynchronous
   *                — residue keeps arriving until the provider processes it
   *                — and the queue-emptying in #dropAnswerInFlight only
   *                discards what has ALREADY arrived. Without this state the
   *                residue refills the queue and the dead answer audibly
   *                resumes: measured 2026-08-18 on gpt-realtime, "count to a
   *                hundred" counted right through a barge, because openai
   *                streams near real time (grok bursts the whole answer up
   *                front, which is why the same gap never sounded on grok).
   *                Cancelled OUTLIVES the response's own `done` — the tool
   *                follow-up gate reads exactly that — and only the next
   *                `response.created`, the first event that can only belong
   *                to a LIVE answer, ends it.
   *
   *   "settled"    nothing streaming and no residue owed: the between-answers
   *                state, and what `response.done` leaves behind when nobody
   *                barged.
   *
   * TRANSCRIPT DELTAS ACCUMULATE IN EVERY PHASE, deliberately: the
   * transcriber lags the audio by seconds (measured 28 characters against
   * 17 s of received audio at a cancel), so the residue transcript arriving
   * post-cancel is exactly what feeds the heard-prefix note when the pending
   * repair settles at `response.done`.
   */
  phase: "streaming" | "cancelled" | "settled";
  /**
   * The provider has finished this answer; say so once the queue is empty.
   *
   * Deliberately NOT "mark the frame that happens to be last": that rule is
   * what made the flag losable. This is a question asked at the drain point,
   * where the answer is always knowable.
   */
  endsWhenQueueDrains: boolean;
  /**
   * Facet clock at this answer's `response.created` — 0 until one arrives.
   * What the button arm compares a press's `createdAt` against: an
   * interruption is a press stamped AFTER the answer it means to stop
   * began, and everything earlier is the dial's own opening retry echoing
   * back through the delivery lane (see the ptt-start barge guard).
   */
  startedAtFacetMs: number;
}

/**
 * A memory repair ready to send: the barged item's identity and the heard
 * milliseconds both halves of the repair name. ONE shape for the dial's
 * `pendingRepair` and for `#settleRepair`'s argument — they used to be the
 * same three fields spelled twice.
 */
interface Repair {
  itemId: string;
  contentIndex: number;
  audioEndMs: number;
}

/** The between-answers state: nothing playing, nothing owed. */
const freshAnswer = (): Answer => ({
  itemId: null,
  contentIndex: 0,
  receivedMs: 0,
  sentMs: 0,
  transcript: [],
  phase: "settled",
  endsWhenQueueDrains: false,
  startedAtFacetMs: 0,
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
  /**
   * The call this dial serves. A Dial belongs to exactly ONE conversation
   * — a re-dial of the same call is a NEW Dial carrying the same id — so
   * the id lives here, per this object's own doctrine ("everything scoped
   * to the dial lives ON it"), instead of threading through every private
   * method as a second argument naming a fact the first argument owns.
   * The closure-captured copy survives only in the appends that outlive
   * the dial: dial-failed, handshake-timeout, socket-closed, idle.
   */
  readonly conversationId: string;
  /** The provider's socket, or null while the dial is still in flight. */
  socket: WebSocket | null;
  /** True once the provider's handshake completed and audio may flow. */
  ready: boolean;
  /**
   * Paced answer audio waiting for its turn on the wire, oldest first — as
   * BASE64, the wire's own spelling, so the frame goes out verbatim. On an
   * identity dial (grok) each entry is an O(1) slice of the provider's own
   * delta string: a ~36 s burst answer used to pay a whole-answer decode
   * (~1.5 M-character atob) at arrival plus a re-encode per frame at send,
   * all on the DO's single thread while mic frames flowed, for
   * byte-identical output. A resampling dial encodes each cut once at
   * arrival — the same total encodes as before, merely off the pacer.
   *
   * NOTHING IN HERE HAS A SEQUENCE NUMBER YET, and that is the point. A number
   * is minted when a frame is HANDED TO THE STREAM, so a number existing means
   * a frame left this machine — which is what makes a hole in the numbering
   * mean one thing instead of two. Numbered at queue time, a barge-in that
   * discarded the queue burned the numbers with it, and the device scored the
   * cancelled audio as lost audio: 5 gaps and 423 absent numbers on a
   * seven-minute call where nothing had actually gone missing.
   */
  speakerQueue: string[];
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
   * Audio has been sent to the provider since the last commit — the gate
   * that keeps a redelivered ptt-end from committing an EMPTY buffer (the
   * ephemeral lane redelivers by design), which drew a provider error and,
   * sometimes, an unprompted second answer spoken from bare context.
   */
  micSentSinceCommit: boolean;
  /**
   * Total mic audio HANDED TO THE PROVIDER this dial, in milliseconds —
   * counted off the device's own 16 kHz base64 at the one send site
   * (#sendMicAudio), BEFORE any resample, because duration survives a
   * resample and the count must share a clock with openai's
   * `audio_start_ms` ("milliseconds from the start of all audio written
   * to the buffer during the session"). One dial IS one provider
   * session, so per-dial accumulation mirrors that clock exactly. Read
   * at a VAD onset: `micSentMs - audio_start_ms` is how much audio left
   * the mic AFTER the user actually started talking — detection lag the
   * heard-ms freeze must backdate, or the schedule counts audio played
   * over the user's own speech as heard.
   */
  micSentMs: number;
  /**
   * A tentative VAD onset holding the floor, or null.
   *
   * SET WHENEVER THE PROVIDER DID NOT CANCEL SERVER-SIDE — grok always
   * (no `interrupt_response`, and a client cancel drew an error every
   * time it was tried), openai only once generation has settled
   * (mid-stream, its pinned `interrupt_response` already killed the
   * response at the onset, so the tail is dead for certain and the
   * destructive arm takes it — see `cancelsOnVadOnset`). The tail this
   * hold protects — up to ~36 s of a burst answer against the device's
   * ≤4 s lead — exists ONLY in `speakerQueue`, and on grok it may still
   * be GROWING: mid-burst deltas keep arriving and keep queueing behind
   * the pause, which is exactly what the hold wants. And the onset is
   * TENTATIVE: five per turn were measured from echo residue, each
   * retracting as a `speech_stopped` with no commit behind it. So the
   * onset silences the DEVICE (the numbered clear — the interrupt still
   * feels instant) but keeps the queue and pauses the pacer until there
   * is a verdict:
   *
   *   CONFIRMS: `input_audio_buffer.committed` — a turn really happened.
   *   The tail is discarded and the memory repair runs with `heardMs`.
   *   (`response.created` is deliberately NOT a confirmation: a real
   *   turn's committed precedes its created on both providers, so a
   *   created that finds a live hold can only be one this agent asked
   *   for itself — see that arm.)
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
   * Whether this dial's provider honors `conversation.item.truncate` — the
   * PROVIDERS row's fact, carried here so the repair sites need no second
   * lookup. False means the note is the WHOLE repair: no wire verb works
   * on that provider's assistant items (see the PROVIDERS table probes).
   */
  truncates: boolean;
  /**
   * The face, when the certificate says something renders one; null costs
   * nothing. Per dial like the classifier it wraps — a re-dial is a new
   * mouth with its answer count back at zero. The whole mouth lifecycle
   * (tracker, answer numbering, the published value) lives in face.ts;
   * this file only feeds it.
   */
  face: ReturnType<typeof createFace> | null;
  /**
   * Whether this dial's provider kills a streaming response itself at a
   * VAD onset — the PROVIDERS row's fact, carried here like `truncates`.
   * The speech_started arm branches on it: true (openai) means a
   * mid-stream onset is destructive for certain; false (grok) means even
   * a mid-burst onset only ever takes the tentative hold, because nothing
   * cancelled the answer anywhere and destroying it turns every echo blip
   * back into the counting bug.
   */
  cancelsOnVadOnset: boolean;
  /**
   * A memory repair that must wait for the cancelled response to FINALIZE.
   *
   * Sent back-to-back with `response.cancel`, the truncate races the
   * server finalizing the item — observed live: the ack and the response's
   * `done` share a millisecond, and the model still remembered the full
   * count. The provider processes client events in order, but the item's
   * transcript is written at finalization; repairing a still-finalizing
   * item is undefined in exactly the way that bit us. Held here until the
   * `response.done` arrives, then sent against a settled item — as a
   * truncate or, on a provider whose truncate is a silent no-op, a delete.
   */
  pendingRepair: Repair | null;
  /**
   * Tool calls issued by the model and not yet answered, by provider call_id.
   * Grok documents parallel calls as "all outputs, then ONE response.create";
   * the follow-up fires when this empties. A future Gemini listener would
   * delete ids here on toolCallCancellation.
   */
  openToolCallIds: Set<string>;
  /**
   * The next `response.created` is one this agent asked for itself — the
   * tool follow-up #runTool sends — not the answer to a user turn.
   *
   * Consumed at `response.created`, where it decides ONE thing: whether
   * the wholesale answer swap also wipes the queue and the device. A
   * follow-up legitimately begins while the previous answer's spoken
   * preamble ("let me check the weather for you", handed over whole
   * inside the pacer's ≤4 s lead) still sits UNPLAYED in the device's
   * buffer, and the unconditional wipe cut it off mid-word — every fast
   * tool call with a spoken preamble, on both providers. Every OTHER
   * path into `response.created` had a barge clear the device first, so
   * the wipe stays for those.
   */
  followUpResponsePending: boolean;
  /**
   * The model decided the call is over; settle at the drain point, after the
   * goodbye PLAYS. v1's instant version was measured cutting "Goodbye!"
   * mid-word. Runtime on purpose: evicted, the 60s idle deadline backstops.
   */
  hangUpAfterAnswerDrains: string | null;
  /**
   * The last colleague activity injected into THIS session, so a status the
   * platform redelivers (or a patch that changes only `waitingFor`) is not
   * whispered twice. Per dial, not per incarnation: a fresh session heard
   * nothing yet, and its briefing already carries the folded status.
   */
  lastColleagueActivity: string | null;
  /**
   * When THIS session last spoke a status line unprompted (facet clock).
   * The floor being free is necessary but not sufficient — a colleague
   * narrating every few seconds must not turn the call into a ticker; one
   * short line per SPOKEN_STATUS_MIN_GAP_MS is the ceiling.
   */
  lastStatusSpokenAtMs: number | null;
  /**
   * A colleague note arrived while an answer held the floor. Drained at
   * `response.done`: the answer finishes ("it's running the code now"),
   * then the note speaks — without this, a push-to-talk caller had to
   * press the button again to hear an answer that had already arrived.
   */
  pendingNoteResponse: boolean;
  /** The answer in flight — replaced wholesale at `response.created`. */
  answer: Answer;
}

/** A dial just decided: no socket yet, nothing sent, a clear owed first. */
const freshDial = (
  conversationId: string,
  provider: {
    rate: number;
    truncates: boolean;
    cancelsOnVadOnset: boolean;
  },
): Dial => ({
  conversationId,
  socket: null,
  ready: false,
  speakerQueue: [],
  lastDeviceSpeakerFrameSeq: 0,
  clearedThroughDeviceSpeakerFrameSeq: 0,
  clearSpeakerBufferBeforeNextFrame: true,
  deviceBufferEmptyAtFacetMs: 0,
  sending: false,
  micSentSinceCommit: false,
  micSentMs: 0,
  tentativeOnset: null,
  micResampler: new Pcm16Resampler(16_000, provider.rate),
  spkResampler: new Pcm16Resampler(provider.rate, 16_000),
  truncates: provider.truncates,
  face: null,
  cancelsOnVadOnset: provider.cancelsOnVadOnset,
  pendingRepair: null,
  openToolCallIds: new Set(),
  followUpResponsePending: false,
  hangUpAfterAnswerDrains: null,
  lastColleagueActivity: null,
  lastStatusSpokenAtMs: null,
  pendingNoteResponse: false,
  answer: freshAnswer(),
});

/* ========================================================================== */
/* PROCESSOR                                                                  */
/* ========================================================================== */

export class VoiceAgentProcessor extends StreamProcessor<
  VoiceAgentContract,
  {
    /** The facet clock. Every `...AtFacetMs` in this file comes from here. */
    nowAtFacetMs(): number;
    /** The build this processor is running (`ITERATE_WORKER_VERSION`, the
     * content-addressed cacheKey) — surfaced in the runtime bag so an
     * operator can tell WHICH build a live facet is, after a day when a
     * stale facet honored a three-commits-old contract while the fresh
     * entrypoint wrote the new one and nothing could say so. */
    buildCacheKey: string;
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
  readonly contract = VoiceAgentContract;

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
   * The device's own base64 strings and nothing else — still 16 kHz
   * semantically, decoded only at the flush and only when the dial's
   * provider speaks another rate, so a re-dial to a DIFFERENT provider
   * still replays at the right rate. `deviceMicFrameSeq` belongs to the
   * device and is never renumbered here, so holding a copy of it would be
   * a field nobody reads. Order in this array IS the order it was captured
   * in.
   *
   * NOT ON THE DIAL, because it can start filling before one exists: a
   * revived incarnation holds frames from deliveries that arrive before the
   * caught-up pass re-dials, and they must survive INTO that dial's
   * session.updated flush — which is why the dial's own reset never touched
   * this queue either.
   */
  #micQueue: string[] = [];
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
   * When this incarnation last saw a conversation end, for the mint
   * cooldown: the frames a device drained in a call's final ~100 ms arrive
   * BEHIND the obituary and must not mint the call's successor. An
   * incarnation rebuilt inside the window forgets it and fails open, which
   * is the old behavior for one delivery in a blue moon.
   */
  #conversationEndedAtMs: number | null = null;
  /**
   * The fold's `lastDeviceInputAtStreamMs`, refreshed on every delivery.
   *
   * A MIRROR, never a second source of truth: the idle loop runs between
   * deliveries and has no way to read the fold, and closing over a stamp would
   * miss a call kept alive by frames that arrived after it started waiting.
   * Written from `state`, plus ONE stamp at the mint: the fold's own
   * `call-started` arm counts opening a call as the device's initial input,
   * and the idle countdown now arms at that same moment — before the log has
   * delivered `call-started` back — so the mint writes the stamp the first
   * tick would otherwise read as zero.
   */
  #lastDeviceInputAtStreamMsMirror = 0;
  /** When the last dial FAILED, for the retry cooldown. Class-level, not on
   * a Dial: the failed dial is already gone when the next caller asks. */
  #lastDialFailedAtFacetMs = 0;
  /**
   * The mirror lane's outbox, drained by ONE background flush at a time.
   *
   * Every provider message and every client control used to be its own
   * runInBackground registration and its own single-event append — and the
   * facet's append opens a full itx session per call, so a grok burst (~77
   * audio deltas plus the transcript deltas, inside a few seconds) was ~150
   * session round trips competing with the pacer on the DO's single
   * thread. The drain swaps this queue out whole and sends it as ONE
   * variadic append, so whatever accumulated while the previous append RPC
   * was in flight coalesces naturally: burst-time RPC count drops about an
   * order of magnitude, idle chatter stays one event per drain. Order
   * within the lane is the FIFO's — which is all the flight recorder ever
   * promised: every payload, verbatim, in arrival order, its
   * `receivedAtFacetMs` stamped at enqueue. Cross-lane ordering against
   * spk-frame was never guaranteed; the mirror was always fire-and-forget.
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
          provider: event.payload.provider ?? "openai",
          providerModel: event.payload.providerModel ?? null,
          providerVoice: event.payload.providerVoice ?? null,
          instructions: event.payload.instructions ?? "",
          clientTakesTurns: event.payload.clientTakesTurns ?? false,
          turnDetection: event.payload.turnDetection ?? null,
          visemes: event.payload.visemes ?? false,
          colleague: event.payload.colleague ?? true,
          colleaguePath: event.payload.colleaguePath ?? null,
          greeting: event.payload.greeting ?? false,
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

      case "events.iterate.com/voice-agent/utterance-transcript": {
        /* An empty transcription is a turn the provider heard as silence;
         * folding it would spend a recap slot saying nothing. */
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
            /* A barged answer's text is what was GENERATED; the recap
             * marks it so the model does not treat words nobody heard as
             * common ground. */
            event.payload.cancelled === true
              ? " (the listener interrupted this answer partway)"
              : "",
          ),
        };
      }

      case "events.iterate.com/voice-agent/colleague-status": {
        /* A status is a PATCH — an absent field means "unchanged" — and it
         * may carry the colleague's own words (`activity`), a lifecycle
         * stage (`phase`), or just a waitingFor flip. Nothing is worth
         * keeping until at least one of the first two has been seen. */
        const activity = event.payload.activity ?? state.colleagueStatus?.activity ?? null;
        const phase = event.payload.phase ?? state.colleagueStatus?.phase ?? null;
        if (activity === null && phase === null) return state;
        return {
          ...state,
          colleagueStatus: {
            activity,
            phase,
            /* Failure follows its phase: a status event that moves past the
             * failed step clears the stale error rather than merging it. */
            failure:
              event.payload.phase === undefined
                ? (state.colleagueStatus?.failure ?? null)
                : (event.payload.failure ?? null),
            waitingFor:
              event.payload.waitingFor === undefined
                ? (state.colleagueStatus?.waitingFor ?? null)
                : event.payload.waitingFor,
          },
        };
      }

      case "events.iterate.com/voice-agent/colleague-note": {
        if (event.payload.text === "") return state;
        return {
          ...state,
          colleagueNotes: [
            ...state.colleagueNotes,
            {
              text:
                event.payload.text.length > COLLEAGUE_NOTE_MAX_CHARS
                  ? `${event.payload.text.slice(0, COLLEAGUE_NOTE_MAX_CHARS)}…`
                  : event.payload.text,
            },
          ].slice(-COLLEAGUE_NOTES_MAX),
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
         * NOT DECODED HERE, on purpose. The frame stays the device's own
         * base64 string all the way to `#sendMicAudio`, the ONE site that
         * knows the encoding: a same-rate provider (grok, 16 kHz) gets the
         * string verbatim with no decode and no re-encode — two O(n)
         * transcodes and two allocations per frame, 50/s on an open mic,
         * that used to buy nothing — and a 24 kHz provider decodes there,
         * at the socket boundary. One site instead of the three that each
         * used to do their own `base64ToBytes`, because the encoding is the
         * kind of thing that gets fixed in two of three.
         */
        const micB64 =
          event.type === "events.iterate.com/voice-agent/mic-frame" ? event.payload.pcm : null;
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
        /* A buried call takes no further input. A NULL call passes — the
         * `?.` makes this one gate serve both shapes, and the mint below is
         * what handles the null. */
        if (state.call?.endRequested != null) return;
        if (state.call === null && !this.#callRequested) {
          /* ONLY SPEECH OPENS A CALL. The ephemeral lane drops and
           * re-delivers, so a lone ptt-end arrives here — and a call minted
           * for it would commit an EMPTY provider buffer: a provider error
           * plus, sometimes, an unprompted answer spoken from bare context,
           * then a zombie call squatting out the idle deadline. */
          if (event.type === "events.iterate.com/voice-agent/ptt-end") return;
          /*
           * AND NOT THE LAST CALL'S DYING BREATH. A device drains its mic
           * queue for ~100 ms after the far end hangs up — it cannot know
           * yet — so those frames arrive right behind the obituary, land on
           * a null call, and minted its successor within 171 ms: the person
           * hears "call ended" twice and a conversation nobody wanted squats
           * out the idle deadline. A fresh WAKE dials by `call-started`, not
           * by this mint, so holding the mint briefly costs a real caller
           * nothing.
           */
          if (
            this.#conversationEndedAtMs !== null &&
            this.deps.nowAtFacetMs() - this.#conversationEndedAtMs < 1500
          ) {
            return;
          }
          /*
           * AND NOT A PRESS FROM ANOTHER ERA. ptt-start is durable so a
           * press that killed its own Durable Object still mints once the
           * rebuilt facet catches up — seconds later. But durable also
           * means a press could in principle be replayed after a LONG
           * facet outage, and a half-hour-old press minting a call to an
           * empty room is worse than a lost one. The device re-presses
           * every 3s while it still wants the call, so 30s of validity
           * loses nobody.
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
           * initial input (the fold's call-started arm says the same), and
           * the countdown starts against this stamp — not against the first
           * mic frame, which a call whose provider dies straight away never
           * receives. `max` so a mint can never walk a fresher stamp back. */
          this.#lastDeviceInputAtStreamMsMirror = Math.max(
            this.#lastDeviceInputAtStreamMsMirror,
            this.deps.nowAtFacetMs(),
          );
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
           *
           * And NO return: the frame that opened the call falls through to
           * the one hold site below like every frame after it — the dial
           * exists (created synchronously above) and is never ready yet, so
           * the mic block holds it. "Hold the frame if room" used to be
           * spelled three times in this case; this fall-through is what
           * deleted two of the copies.
           */
          this.#openProviderConnection(conversationId, state, append, runInBackground);
        }

        /*
         * THE BUTTON IS AN INTERRUPTION, and in push-to-talk it is the ONLY
         * one anybody sends. `turn_detection` is null when the client owns its
         * turns, so the provider never reports speech starting and the two
         * provider events that used to be the whole of barge-in cannot fire.
         * Without this arm the dead answer keeps streaming to the speaker for
         * the entire press and only stops when the NEXT answer begins.
         * #bargeAnswer carries the rest of the story; the press is its one
         * caller that also cancels — no provider VAD will ever cancel for a
         * button. Guarded on the FOLD's call, not just the dial: the press
         * that MINTED the call above barges nothing, same reachability as
         * when the mint block still returned early.
         */
        if (event.type === "events.iterate.com/voice-agent/ptt-start" && state.call !== null) {
          const dial = this.#dial;
          /* No dial means nothing playing and nothing to cancel: a press on
           * a revived incarnation that has not re-dialled yet changes
           * nothing until the caught-up pass opens the connection. */
          /* AND NOT THE DIAL'S OWN ECHO. The device re-presses every 3s
           * while it still wants the call (the durable-press retry that
           * survives a cold Durable Object), and those presses are stamped
           * BEFORE any answer existed. The delivery lane hands them over
           * seconds late — measured on the HA Voice PE: every long answer
           * died at "1, 2," on a bare clear with no provider event in
           * sight, because the call's own opening retry landed here and
           * barged the answer it had minted, `response.cancel` and all. An
           * interruption is a press stamped AFTER the answer it means to
           * stop began — every observed retry predates its answer's
           * `response.created` by the handshake it was still retrying
           * (400ms at the tightest, seconds normally). The 250ms guard
           * band absorbs stream-vs-facet wall-clock skew without eating a
           * press stamped at the answer's own tick, and a press with no
           * readable stamp or no dated answer stays an interruption,
           * because a human's press must never be the one that gets
           * dropped. */
          const pressedAtStreamMs = Date.parse(event.createdAt);
          const answerStartedAtFacetMs = dial?.answer.startedAtFacetMs ?? 0;
          const pressIsOpeningEcho =
            Number.isFinite(pressedAtStreamMs) &&
            answerStartedAtFacetMs > 0 &&
            pressedAtStreamMs < answerStartedAtFacetMs - 250;
          if (dial !== null && !pressIsOpeningEcho) {
            /* Heard-ms is read BEFORE the barge zeroes the pacer's schedule.
             * (A `spkBufferedMs` device stamp was read here as the preferred
             * source — the device is the authority on what it played, and the
             * schedule models the WORST CASE lead — but no device or CLI ever
             * produced the field, so the read was a branch that had never
             * once run. Deleted; if a device grows the stamp, declare it in
             * the ptt-start contract and take it as the authority again.) */
            const nowAtFacetMs = this.deps.nowAtFacetMs();
            this.#bargeAnswer(
              dial,
              this.#heardMsFromSchedule(dial, nowAtFacetMs),
              nowAtFacetMs,
              append,
              true,
            );
          }
        }

        if (micB64 !== null) {
          const dial = this.#dial;
          if (dial !== null && dial.ready && dial.socket !== null) {
            this.#sendMicAudio(dial, dial.socket, micB64);
          } else if (this.#micQueue.length < MAX_HELD_MIC_FRAMES) {
            this.#micQueue.push(micB64);
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
          /* Only a turn that carried AUDIO commits — the ephemeral lane
           * redelivers, and a duplicate ptt-end against an empty provider
           * buffer drew an error plus, sometimes, an unprompted answer. */
          if (dial !== null && dial.ready && dial.socket !== null && dial.micSentSinceCommit) {
            this.#askForAnswer(dial);
          }
        }
        return;
      }

      /* There is NO conversation-end-requested arm. reduce folds the decision
       * before delivery reaches this switch, so the caught-up pass above has
       * already hung up and written the obituary on the very delivery that
       * carried the event — and it, unlike an arm, also retries an obituary
       * that an earlier incarnation died owing. An arm here was the same
       * action twice behind one idempotency key. */

      case "events.iterate.com/voice-agent/colleague-status": {
        /*
         * THE WHISPER. A status change reaches the live session as a quiet
         * context item, built from the FOLD so it carries both halves —
         * lifecycle phase and the colleague's own words. No dial (or a dial
         * mid-handshake, whose #sendControl no-ops) loses nothing: the fold
         * kept the status and the next session's briefing carries it. A
         * failed script carries its error, because "say so, don't invent"
         * needs the truth on hand.
         */
        const text = colleagueStatusWhisper(state.colleagueStatus);
        if (text === null) return;
        const dial = this.#dial;
        if (dial === null || dial.lastColleagueActivity === text) return;
        dial.lastColleagueActivity = text;
        this.#sendControl(
          dial,
          {
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "system",
              content: [{ type: "input_text", text }],
            },
          },
          append,
        );
        /*
         * AND, SOMETIMES, A SPOKEN LINE. A status worth interrupting the
         * silence for — the colleague's own words changed, or something
         * failed — draws one response.create so the frontend can SAY it
         * ("it's running the code now") instead of only knowing it. The
         * instructions own the judgement and the brevity; this arm owns
         * when speech is even possible: the floor free (nothing streaming,
         * no tool open), the person not mid-hold, ≥ the gap since the last
         * unprompted line, and never for a `quiet` status (the facet's own
         * note-dispatch echo) or bare phase churn (writing → running →
         * finished flips every few seconds; the whisper already carries
         * them).
         */
        const newsworthy =
          event.payload.quiet !== true &&
          (typeof event.payload.activity === "string" ||
            (typeof event.payload.failure === "string" && event.payload.failure !== ""));
        if (
          newsworthy &&
          dial.ready &&
          dial.openToolCallIds.size === 0 &&
          dial.answer.phase === "settled" &&
          !dial.followUpResponsePending &&
          !dial.micSentSinceCommit &&
          (dial.lastStatusSpokenAtMs === null ||
            this.deps.nowAtFacetMs() - dial.lastStatusSpokenAtMs >= SPOKEN_STATUS_MIN_GAP_MS)
        ) {
          dial.lastStatusSpokenAtMs = this.deps.nowAtFacetMs();
          /* The follow-up lane, not a barge: the previous answer's tail may
           * still be draining and must finish playing. */
          dial.followUpResponsePending = true;
          this.#sendControl(dial, { type: "response.create" }, append);
        }
        return;
      }

      case "events.iterate.com/voice-agent/colleague-note": {
        /* At-least-once delivery can hand the same note twice; injecting it
         * twice makes the model repeat itself. Offsets are monotonic, so
         * one high-water mark is the whole dedupe. */
        if (event.offset <= this.#lastInjectedNoteOffset) return;
        this.#lastInjectedNoteOffset = event.offset;
        /*
         * THE REPLY EVENT. Every chat message the colleague sends arrives
         * here, durably — solicited or not — and is read into whichever
         * call is live. No call (or a dial mid-handshake, whose
         * #sendControl no-ops): nothing is lost — the fold kept the note
         * and the next session's briefing carries it.
         */
        const noteText = event.payload.text;
        if (typeof noteText !== "string" || noteText === "") return;
        const dial = this.#dial;
        if (dial === null) return;
        this.#sendControl(
          dial,
          {
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "system",
              content: [{ type: "input_text", text: `[note from your backend] ${noteText}` }],
            },
          },
          append,
        );
        /* Same floor discipline as a tool follow-up: speak the note only
         * when nothing else holds the floor. `followUpResponsePending`
         * closes a race the phase alone cannot: `answer.phase` flips only
         * when the provider echoes response.created, so two quick triggers
         * (a greeting, then a note landing mid-handshake) would both read
         * "settled" and stack two response.creates — a note landing behind
         * an already-requested response simply rides it. And a note that
         * lands MID-ANSWER (typically mid status line — "it's running the
         * code now") is not dropped to the next press: pendingNoteResponse
         * re-creates at `response.done`, so the answer follows the status
         * straight away. */
        if (
          dial.openToolCallIds.size === 0 &&
          dial.answer.phase === "settled" &&
          !dial.followUpResponsePending
        ) {
          dial.followUpResponsePending = true;
          this.#sendControl(dial, { type: "response.create" }, append);
        } else if (dial.answer.phase !== "settled" || dial.openToolCallIds.size > 0) {
          dial.pendingNoteResponse = true;
        }
        return;
      }

      case "events.iterate.com/voice-agent/conversation-ended": {
        /*
         * THE ARM THAT WAS DELETED AS DEAD, AND WHY IT IS BACK. Reduce nulls
         * `state.call` before delivery reaches this switch, so a guard on
         * STATE was indeed unreachable — but the guard was never the point.
         * A DEVICE-appended obituary (the hang-up button) takes this path
         * without any end-requested ever existing, so the caught-up
         * settlement never runs, and deleting this arm left the DIAL alive:
         * a zombie provider socket squatting `#dial`, blocking every new
         * dial until the 60 s idle tick finally killed it. Measured on
         * HAVPE 2026-08-19 — a button end at :56:25, the zombie idled out
         * at :01:32, and every press in between was deaf. The fence is the
         * DIAL's own conversation, which a stale obituary cannot name.
         *
         * And the device is silenced NOW: a call that ends mid-answer
         * leaves up to the pacer's whole lead buffered in the ring, and
         * "the call is over" must not sound like four more seconds of it.
         */
        /* Arms the mint cooldown below: the mic frames a device drained in
         * the last ~100 ms of a call arrive AFTER this event, and a call
         * minted for them is the zombie the person hears as a second
         * "call ended" — measured relaunches 87 and 171 ms after an end. */
        this.#conversationEndedAtMs = this.deps.nowAtFacetMs();
        const dial = this.#dial;
        if (dial !== null && dial.conversationId === event.payload.conversationId) {
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
    state: ProcessEventArgs<VoiceAgentContract>["state"],
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    if (this.#dial !== null) return;
    /* The one choke point both callers share, so a dead provider cannot be
     * re-dialled at frame cadence — see DIAL_RETRY_COOLDOWN_MS. */
    if (this.deps.nowAtFacetMs() - this.#lastDialFailedAtFacetMs < DIAL_RETRY_COOLDOWN_MS) return;
    const provider = PROVIDERS[state.provider];
    /* CREATED BEFORE THE AWAITED DIAL, so a second caller finds `#dial`
     * taken and the mic path queues for the whole handshake. The socket
     * arrives below; everything else the dial owns starts fresh here. */
    const dial = freshDial(conversationId, provider);
    if (state.visemes) dial.face = createFace();
    this.#dial = dial;
    /* THE COLLEAGUE LINK STANDS FROM CALL START, not from the first note:
     * the transcript lane it installs is how the backend hears the
     * conversation, and a call with no note still deserves a record on the
     * colleague's stream. Background and swallowed — the note path retries
     * it, and a call must not fail because the desk was unreachable. */
    if (state.colleague) {
      runInBackground(() => this.#ensureColleagueLink(state).catch(() => {}));
    }
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
       * held sentence waits out the idle deadline. A throw IS a refusal,
       * and both failures share one exit: same key, same teardown, only
       * the reason differs. */
      let socket: WebSocket | null = null;
      let failure = "the provider refused the connection";
      try {
        socket = await this.deps.dialProvider(
          state.provider,
          state.providerBaseUrl,
          state.providerModel ?? provider.model,
        );
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
       * THE HANDSHAKE GETS A DEADLINE, because the idle backstop cannot see
       * this wedge: an open-mic board's frames keep the idle stamp fresh
       * while the un-ready dial holds them, so a session.update the provider
       * never answers is a call that is silent FOREVER with nothing logged.
       * Nulling #dial first fences the close listener out; the obituary
       * says what actually happened.
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
        this.#forwardProviderEvent(dial, grok, providerEventType, receivedAtFacetMs, append);

        switch (providerEventType) {
          case "session.created":
            /* The one edge that makes us configure the session; miss it and
             * the handshake never completes and the call hangs, silently. */
            socket.send(
              JSON.stringify({
                type: "session.update",
                session: {
                  type: "realtime",
                  ...((state.instructions !== "" ||
                    state.colleague ||
                    state.transcript.length > 0) && {
                    instructions: [
                      ...(state.instructions === "" ? [] : [state.instructions]),
                      ...(state.colleague ? [FAST_HALF_INSTRUCTIONS] : []),
                      /* The recap: a fresh provider session is a stranger,
                       * and the fold remembers so it does not have to be. */
                      ...(state.transcript.length > 0 ? [transcriptRecap(state.transcript)] : []),
                      /* A note still on the colleague's desk survives the
                       * reconnect too — saying so is what stops this session
                       * re-sending the same note (measured: a reconnected
                       * session re-asked and the duplicate answer was never
                       * even deliverable). */
                      ...(state.colleagueStatus !== null &&
                      state.colleagueStatus.waitingFor === null
                        ? [
                            `Your backend is mid-task right now — its latest status: ` +
                              `"${[state.colleagueStatus.phase, state.colleagueStatus.activity]
                                .filter(Boolean)
                                .join(" — ")}"` +
                              (state.colleagueStatus.failure === null
                                ? ""
                                : ` (a script failed: ${state.colleagueStatus.failure})`) +
                              `. Its reply will arrive as a bracketed note; do not send another ` +
                              `note for the same request.`,
                          ]
                        : []),
                      /* Notes that landed between calls were spoken to
                       * nobody; the reconnect inherits them. */
                      ...(state.colleagueNotes.length > 0
                        ? [
                            [
                              "Recent notes from your backend, oldest first (the conversation " +
                                "record above shows which, if any, you already relayed):",
                              ...state.colleagueNotes.map((note) => `- ${note.text}`),
                            ].join("\n"),
                          ]
                        : []),
                    ].join("\n\n"),
                  }),
                  /* The certificate's tools, declared verbatim; the GA shape
                   * both providers speak. The expression never touches the
                   * wire — the provider knows names, we know what they do. */
                  ...((state.tools.length > 0 || state.colleague) && {
                    tool_choice: "auto",
                    tools: [...state.tools, ...(state.colleague ? [NOTE_TO_SELF_TOOL] : [])].map(
                      ({ name, description, parameters }) => ({
                        type: "function",
                        name,
                        description,
                        parameters: parameters ?? { type: "object", properties: {} },
                      }),
                    ),
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
                      /* The certificate's own turn_detection wins over the
                       * defaults, verbatim — the stream knows its room. */
                      turn_detection: state.clientTakesTurns
                        ? null
                        : (state.turnDetection ??
                          (state.provider === "openai"
                            ? {
                                ...SERVER_VAD,
                                interrupt_response: true,
                                create_response: true,
                                silence_duration_ms: 500,
                              }
                            : SERVER_VAD)),
                      /* The boards are far-field boxes, and the 0.85 VAD
                       * threshold exists because of their echo residue —
                       * this is the knob that may one day let it drop.
                       * OpenAI-only: grok's docs are silent on it. */
                      ...(state.provider === "openai" && {
                        noise_reduction: { type: "far_field" },
                        /* The user's side of the conversation, transcribed
                         * by the provider and mirrored to the lane like
                         * every other provider event. Until this, the
                         * durable record held everything the MODEL said and
                         * nothing anybody said TO it — and the acoustic
                         * board proof had no way to show the provider heard
                         * the words that were spoken through air. */
                        transcription: { model: "gpt-live-transcribe" },
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
              try {
                this.#sendMicAudio(dial, socket, held);
              } catch {
                /* A malformed held frame (bad base64, decoded only on a
                 * resampling dial) must not cost the rest of the queue or
                 * the held-turn commit below. It used to throw at ingress,
                 * before it could be held; holding strings moved the decode
                 * here. On the identity dial nothing decodes and nothing
                 * throws. */
              }
            }
            this.#micQueue = [];
            /*
             * AND THE END OF THE TURN, if it happened while we were connecting.
             * The held capture is only a question once somebody commits it —
             * without this the provider holds a complete sentence in its input
             * buffer and waits, for ever, for an instruction that was thrown
             * away sixty seconds earlier.
             */
            const turnEndedDuringThisHandshake = this.#turnEndedDuringHandshake;
            if (
              this.#turnEndedDuringHandshake &&
              state.clientTakesTurns &&
              dial.micSentSinceCommit
            ) {
              this.#askForAnswer(dial);
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
            /*
             * THE PICKUP GREETING. Only when nobody has spoken yet: a caller
             * already mid-sentence (held frames, or a whole turn ended
             * during the handshake) came to talk, not to be welcomed over.
             */
            if (state.greeting && heldMicFrames === 0 && !turnEndedDuringThisHandshake) {
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
                          "[the call just connected — greet the person briefly, a few words. " +
                          "If the conversation record above shows you have spoken before, greet " +
                          "them like the returning caller they are.]",
                      },
                    ],
                  },
                },
                append,
              );
              if (!dial.followUpResponsePending) {
                dial.followUpResponsePending = true;
                this.#sendControl(dial, { type: "response.create" }, append);
              }
            }
            return;
          }

          case "input_audio_buffer.committed":
            /* A commit is a turn that really happened, so the onset that
             * preceded it was no echo blip. A RETRACTED hold confirms here
             * too: a real turn's speech_stopped and committed arrive in the
             * same server tick, and the frozen number from the silence is
             * still the honest one. */
            this.#confirmTentativeOnset(dial, append);
            return;

          case "input_audio_buffer.speech_started": {
            /*
             * THE BOARDS' ONLY BARGE. An open microphone has no button, so
             * this onset is the one interruption an open-mic client ever
             * produces — and it is TENTATIVE: five per turn were measured
             * from echo residue, each retracting as a `speech_stopped` with
             * no commit behind it. Which story it opens depends on whether
             * the provider CANCELLED anything at this onset.
             *
             * AND IT ARRIVES LATE. The event names where speech began —
             * `audio_start_ms`, openai's position in the session's mic
             * audio, prefix padding already backdated; grok's carries no
             * such field, so its lag reads zero — and `micSentMs` is how
             * much mic audio had been sent when the event landed. The
             * difference is audio captured AFTER the user started talking:
             * detection time during which the schedule kept advancing and
             * the speaker kept playing over the user's own speech. Nothing
             * played over the user was heard, so BOTH freeze sites below
             * backdate their heard-ms by it (measured 0.6-1.1 s — 2-3
             * counted numbers of recall error on their own).
             */
            const onsetLagMs =
              typeof grok.audio_start_ms === "number"
                ? Math.max(0, dial.micSentMs - grok.audio_start_ms)
                : 0;
            if (dial.answer.phase === "streaming" && dial.cancelsOnVadOnset) {
              /*
               * STILL GENERATING, AND THE PROVIDER KILLED IT SERVER-SIDE at
               * this very onset (openai's server_vad `interrupt_response`,
               * pinned true in our session.update): the tail is dead for
               * certain, so the answer dies exactly as a press kills it —
               * with cancel:false, because a client cancel on top of the
               * server's is a second owner of one cancellation. The barged
               * response still finalizes with a `response.done`, which is
               * where the pending repair settles.
               *
               * Heard-ms is read BEFORE the barge zeroes the pacer's
               * schedule, same as the press.
               */
              this.#bargeAnswer(
                dial,
                Math.max(
                  0,
                  Math.floor(this.#heardMsFromSchedule(dial, receivedAtFacetMs) - onsetLagMs),
                ),
                receivedAtFacetMs,
                append,
                false,
              );
              return;
            }
            /*
             * EVERYTHING ELSE HOLDS. Either generation already finished
             * (grok bursts whole answers up front, so the unsent tail — up
             * to ~36 s against the device's ≤4 s lead — lives ONLY in the
             * local queue), or the provider is one that cancels NOTHING at
             * an onset (grok mid-burst: no interrupt_response, and a client
             * cancel drew an error every time — deltas keep arriving and
             * keep queueing behind this pause, which is exactly what the
             * hold wants). Emptying the queue on a tentative onset was the
             * counting bug in a second form: the header's "one flush and
             * four no-ops" was true of the DEVICE's buffer and false of
             * this one. So the device is silenced NOW (the numbered clear —
             * the interrupt still feels instant), the schedule is zeroed to
             * say so, and the queue WAITS:
             *
             *   CONFIRMS: `input_audio_buffer.committed` — discard the
             *   tail, repair the memory.
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
              const heardMs = Math.max(
                0,
                Math.floor(this.#heardMsFromSchedule(dial, receivedAtFacetMs) - onsetLagMs),
              );
              dial.tentativeOnset = { heardMs, retracted: false };
              /* The clear below throws the device's unplayed lead away, and
               * a retraction never resends it — the HOLE above. Left alone,
               * that lead stays inside `sentMs` and every later heard-ms of
               * this answer counts it as played. Rolled back to the frozen
               * number, a resumed tail re-earns the start lag its restart
               * really pays: the firmware re-prefills after a clear. */
              dial.answer.sentMs = heardMs;
            }
            this.#clearDeviceSpeaker(dial, receivedAtFacetMs, append);
            dial.deviceBufferEmptyAtFacetMs = 0;
            return;
          }

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
              this.#sendSpeakerAudio(dial, append, runInBackground);
            }
            return;

          case "response.created": {
            /* A created event can only belong to a LIVE answer, so it is
             * what ends a barge's residue-discard window — and it is where
             * the per-answer state is replaced WHOLESALE, identity and
             * clocks included.
             *
             * A STILL-HELD ONSET HERE: WHOSE CREATED IS THIS?
             *
             * OURS (`followUpResponsePending` — the tool follow-up;
             * push-to-talk has no VAD onsets): nobody interrupted, so no
             * repair note. Confirming here was a real bug — a fast tool
             * landing inside an echo blip discarded the held tail and told
             * the model "the user interrupted your previous spoken reply"
             * when the blip would have retracted milliseconds later. The
             * hold is simply dropped.
             *
             * THE PROVIDER'S: a real turn is beginning, and this created IS
             * the confirmation — grok creates a turn's response BEFORE its
             * `committed` arrives (measured live: created at .456, stopped
             * at .652, committed at .708 of the same barge), so waiting for
             * the commit confirms nothing: this arm's own swap would have
             * erased the barged answer's identity and transcript first, and
             * the note never went out — the model recalled a count nobody
             * heard. Confirm NOW, before the swap, so the repair reads the
             * old answer. OpenAI's order (committed first) still confirms
             * at the committed arm; both arms share the no-op guard. */
            const followUp = dial.followUpResponsePending;
            dial.followUpResponsePending = false;
            if (followUp) {
              dial.tentativeOnset = null;
            } else {
              this.#confirmTentativeOnset(dial, append);
            }
            dial.answer = freshAnswer();
            dial.answer.phase = "streaming";
            dial.answer.startedAtFacetMs = receivedAtFacetMs;
            /* A new answer is a new signal; without this, the filter's
             * held tail of a CANCELLED answer would smear its first
             * milliseconds. */
            dial.spkResampler.reset();
            /* And a new mouth track — face.ts owns why. */
            dial.face?.answerStarted();
            if (followUp) {
              /* The follow-up this agent asked for: the previous answer's
               * spoken preamble is still draining — most of it UNPLAYED in
               * the device's buffer inside the ≤4 s lead — and no barge
               * cleared it, so wiping here cut "let me check the weather
               * for you" off mid-word on every fast tool call. Kick the
               * pacer instead: a tail a hold may have parked resumes and
               * the new answer queues behind it. */
              this.#sendSpeakerAudio(dial, append, runInBackground);
            } else {
              /* Every other created follows a barge (whose clear makes this
               * a watermark no-op) or replaces an answer nobody defended:
               * a new answer is a flush of the old one. */
              this.#dropAnswerInFlight(dial, receivedAtFacetMs, append);
            }
            return;
          }

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

          /*
           * THE TWO DURABLE TRANSCRIPT APPENDS. Each finished turn leaves one
           * event carrying its words — the fold's recap and the stream's only
           * readable record both hang off these. Keyed on the provider's own
           * item id, so a rescued call's second handshake cannot write a turn
           * twice; a cancelled answer is recorded too, marked, because the
           * model said it even if nobody heard it out.
           */
          case "response.output_audio_transcript.done": {
            if (typeof grok.transcript !== "string" || grok.transcript === "") return;
            const cancelled =
              dial.answer.itemId === grok.item_id && dial.answer.phase === "cancelled";
            const itemId = typeof grok.item_id === "string" ? grok.item_id : crypto.randomUUID();
            this.runInBackground(() =>
              append({
                type: "events.iterate.com/voice-agent/answer-transcript",
                idempotencyKey: this.idempotencyKey(`answer-transcript:${itemId}`),
                payload: {
                  conversationId,
                  /* Narrowed by the typeof guard above; the narrowing dies
                   * at this closure boundary, so the cast restates it. */
                  text: grok.transcript as string,
                  ...(cancelled && { cancelled: true }),
                },
              }),
            );
            return;
          }

          case "conversation.item.input_audio_transcription.completed": {
            if (typeof grok.transcript !== "string" || grok.transcript.trim() === "") return;
            const itemId = typeof grok.item_id === "string" ? grok.item_id : crypto.randomUUID();
            this.runInBackground(() =>
              append({
                type: "events.iterate.com/voice-agent/utterance-transcript",
                idempotencyKey: this.idempotencyKey(`utterance-transcript:${itemId}`),
                /* Same shape as above: guarded by typeof at the case's top;
                 * the closure boundary loses the narrowing. */
                payload: { conversationId, text: grok.transcript as string },
              }),
            );
            return;
          }

          case "response.output_audio.delta": {
            if (typeof grok.delta !== "string") return;
            /* Residue of a cancelled answer: dead on arrival. */
            if (dial.answer.phase === "cancelled") return;
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
            if (
              dial.spkResampler.fromRate === dial.spkResampler.toRate &&
              grok.delta.length % 4 === 0
            ) {
              /* A 16 kHz provider's delta bytes ARE the pipeline's bytes, so
               * the whole answer stays base64 end to end: cut the STRING at
               * group boundaries (see IDENTITY_SLICE_BYTES) and never decode
               * it. The interior slices carry no padding, the final slice
               * keeps the delta's own. Guarded on `% 4`: atob tolerates the
               * ragged base64 that group-aligned slicing would silently
               * corrupt into noise on the device, so anything unaligned
               * takes the decode path below and one modulo is the whole
               * cost. */
              dial.answer.receivedMs += base64ByteLength(grok.delta) / PCM16_BYTES_PER_MS;
              for (let cut = 0; cut < grok.delta.length; cut += IDENTITY_SLICE_B64_CHARS) {
                dial.speakerQueue.push(grok.delta.slice(cut, cut + IDENTITY_SLICE_B64_CHARS));
              }
              /* The FACE is deliberately not fed here: the whole answer can
               * arrive in one burst, and a mouth folded at ingest races to
               * the answer's final shape while the device spends seconds
               * playing it — measured 6 shape changes across a six-second
               * answer. The pacer feeds it at send time instead. */
            } else {
              /* The pipeline is 16 kHz from here to the speaker; a provider
               * that talks faster gets resampled at the door — and encoded
               * per cut HERE, at arrival, not on the pacer's clock. */
              const pcm16 = dial.spkResampler.push(base64ToBytes(grok.delta));
              dial.answer.receivedMs += pcm16.length / PCM16_BYTES_PER_MS;
              for (let cut = 0; cut < pcm16.length; cut += MAX_SPEAKER_PAYLOAD_BYTES) {
                dial.speakerQueue.push(
                  bytesToBase64(
                    pcm16.subarray(cut, Math.min(cut + MAX_SPEAKER_PAYLOAD_BYTES, pcm16.length)),
                  ),
                );
              }
            }
            this.#sendSpeakerAudio(dial, append, runInBackground);
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
            if (dial.answer.phase === "cancelled") return;
            dial.answer.phase = "settled";
            dial.answer.endsWhenQueueDrains = true;
            /* The mouth's SIL rides the drain marker with the rest of the
             * face track — closing it here, at ingest, shut the mouth
             * seconds before the device finished speaking. */
            this.#sendSpeakerAudio(dial, append, runInBackground);
            return;

          case "response.done": {
            /* Every response ends here, audio or not — a pure function-call
             * response never sends output_audio.done, so without this the
             * NEXT press would cancel a response that no longer exists. A
             * CANCELLED answer stays cancelled: its residue window closes
             * only at the next `response.created`, and the tool follow-up
             * gate reads exactly that. */
            if (dial.answer.phase === "streaming") dial.answer.phase = "settled";
            /* The barged response is now FINAL — whether a press cancelled
             * it or the provider's own VAD did — so the deferred repair
             * can no longer race the item's own finalization. */
            const pending = dial.pendingRepair;
            if (pending !== null && dial.ready && dial.socket !== null) {
              dial.pendingRepair = null;
              this.#settleRepair(dial, pending, append);
            }
            /* The floor is free; a hang-up waiting on the drain settles now. */
            this.#sendSpeakerAudio(dial, append, runInBackground);
            /* A note that arrived mid-answer gets its turn NOW — push-to-talk
             * has no next VAD turn to carry it, and "press the button again
             * to hear the answer you were promised" was the observable bug.
             * Settled only: a cancelled answer means the person took the
             * floor, and the note waits for their turn to finish. */
            if (
              dial.pendingNoteResponse &&
              dial.answer.phase === "settled" &&
              dial.openToolCallIds.size === 0 &&
              dial.hangUpAfterAnswerDrains === null
            ) {
              dial.pendingNoteResponse = false;
              dial.followUpResponsePending = true;
              this.#sendControl(dial, { type: "response.create" }, append);
            }
            return;
          }

          case "response.function_call_arguments.done": {
            /* Residue discipline, same as audio: a cancelled response's tool
             * call is an intent the user erased, and running it anyway is the
             * barge failing at the worst altitude — a side effect. */
            if (dial.answer.phase === "cancelled") return;
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
              /* The injected tool resolves here, not from the certificate, so
               * no certificate can shadow it with an expression of its own. */
              state.colleague && grok.name === NOTE_TO_SELF_TOOL.name
                ? NOTE_TO_SELF_TOOL
                : state.tools.find((tool) => tool.name === grok.name),
              modelArgs,
              state,
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
          this.#requestEnd(conversationId, "socket-closed", "Grok's socket closed", append),
        );
      });
    });

    /*
     * THE IDLE COUNTDOWN ARMS THE MOMENT THE DIAL IS DECIDED — at the mint
     * or the caught-up re-dial, NOT once a socket has been adopted. It used
     * to arm after the awaited dial handed its socket over, which left a
     * whole class of call with no countdown at all: a dial that never
     * resolves, or a socket that died without ever firing its close event,
     * kept `#dial` occupied with nothing armed to bury the call — the fold
     * said a call was up, so every later press was swallowed by "a call is
     * already up" for ever (the stackchan ghost, 2026-08-20: a call whose
     * provider socket died just after accept squatted for six minutes of
     * 3-second press retries until a manual zombie-cleanup). The mint stamps
     * the idle mirror, so call-started time counts as the device's initial
     * input and a call that never hears its device dies at the same 60s.
     *
     * A SELF-RESCHEDULING TICK CHAIN, not a loop. One background closure
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
      await this.#requestEnd(
        conversationId,
        "idle",
        `no input from the device for ${IDLE_TIMEOUT_MS / 1000}s`,
        append,
      );
    };
    this.runInBackground(idleTick);
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
    dial: Dial,
    grok: Record<string, unknown>,
    providerEventType: string,
    receivedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    if (providerEventType === "response.output_audio.delta") {
      const { delta, ...rest } = grok;
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
        { ...grok, conversationId: dial.conversationId, receivedAtFacetMs },
        append,
      );
    }
  }

  /**
   * Put one payload on the mirror lane — see `#mirrorQueue` for why this is
   * a queue and a single drain rather than an append per event.
   */
  #appendMirror(
    payload: Record<string, unknown> & { conversationId: string; receivedAtFacetMs: number },
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    this.#mirrorQueue.push({ payload, append });
    if (this.#mirrorFlushing) return;
    this.#mirrorFlushing = true;
    this.runInBackground(async () => {
      /* The flag clears in a finally around the WHOLE loop: a rejected
       * append (runInBackground logs it) loses only its own batch, never
       * the lane — a stuck flag would silence the recorder for the rest of
       * the call. */
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

  /**
   * One resample-at-send rule for both mic paths — live frames and the
   * held-flush at session.updated — because the encoding is the kind of
   * thing that gets fixed in one of two sites. THE ONE SITE THAT KNOWS THE
   * ENCODING: on an identity dial (grok — the pipeline's own 16 kHz) the
   * device's base64 goes to the wire VERBATIM, because decoding it only to
   * re-encode the same bytes was two O(n) passes and two allocations per
   * frame at 50/s for byte-identical output; a 24 kHz dial decodes,
   * resamples through the dial's stateful converter, and re-encodes here,
   * at the socket boundary. Also the one place the commit gate learns
   * audio exists to commit.
   */
  #sendMicAudio(dial: Dial, socket: WebSocket, b64: string): void {
    socket.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio:
          dial.micResampler.fromRate === dial.micResampler.toRate
            ? b64
            : bytesToBase64(dial.micResampler.push(base64ToBytes(b64))),
      }),
    );
    dial.micSentSinceCommit = true;
    /* Counted on the INCOMING b64 — the pipeline's 16 kHz — after the send,
     * so a frame the resampler throws on was never counted: the provider
     * never received it either. See `micSentMs` for why not the wire's rate. */
    dial.micSentMs += base64ByteLength(b64) / PCM16_BYTES_PER_MS;
  }

  /**
   * Commit the captured turn and ask for an answer — the two sends that a
   * client owning its own turns pays for, kept together so neither can be
   * forgotten alone. Consumes the commit gate: the next ptt-end needs new
   * audio behind it.
   */
  #askForAnswer(dial: Dial): void {
    dial.socket?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    dial.socket?.send(JSON.stringify({ type: "response.create" }));
    dial.micSentSinceCommit = false;
  }

  /**
   * One obituary shape for every reason this processor decides a call is
   * over — it was the identical append spelled out five times. The key
   * class scopes the dedupe: a retried decision collides with itself and
   * never with a different reason's. Each site keeps its own scheduling
   * (the close listener cannot await; the rest do), which is why this
   * returns the append's promise instead of hiding it.
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
    state: ProcessEventArgs<VoiceAgentContract>["state"],
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    dial.openToolCallIds.add(callId);
    runInBackground(async () => {
      let output: string;
      if (tool === undefined) {
        output = JSON.stringify({ error: "no such tool" });
      } else if (tool.name === NOTE_TO_SELF_TOOL.name && tool.expression === undefined) {
        /* The note is FIRE-AND-FORGET from the tool's point of view: the
         * output settles now so the model keeps talking, and the reply —
         * if one ever comes — arrives later as a bracketed note. */
        const note =
          typeof (modelArgs as { note?: unknown })?.note === "string"
            ? ((modelArgs as { note: string }).note ?? "")
            : String(modelArgs ?? "");
        this.#noteToColleague(note, state, append, runInBackground);
        output = JSON.stringify({
          status:
            "noted — the reply arrives later as a bracketed note; keep the conversation going",
        });
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
        append,
      );
      /* ONE follow-up, only when the floor is free: all parallel outputs in
       * (grok's documented contract), the answer settled — neither still
       * talking nor inside a barge's residue window, because the press owns
       * the floor it took. hang_up asks for nothing: it is something the
       * assistant DID, not something to talk about. */
      if (
        tool?.expression !== undefined &&
        dial.openToolCallIds.size === 0 &&
        dial.answer.phase === "settled"
      ) {
        /* The created this draws must not wipe the device — the spoken
         * preamble is usually still sitting unplayed there. See
         * `followUpResponsePending`. */
        dial.followUpResponsePending = true;
        this.#sendControl(dial, { type: "response.create" }, append);
      }
    });
  }

  /**
   * The link install this incarnation has already run (or has in flight) —
   * an RPC saver, not the truth: every append inside dedupes server-side by
   * idempotency key, so a rebuilt incarnation that re-runs them pays a few
   * no-op round trips and nothing else. Reset on failure so the next call
   * or note retries.
   */
  #colleagueLink: Promise<void> | null = null;

  /** Highest colleague-note offset already injected into a session — the
   * redelivery dedupe for the note whisper (see the colleague-note arm). */
  #lastInjectedNoteOffset = 0;

  /** Where this stream's colleague lives — see colleaguePathForStream. */
  #colleaguePath(state: ProcessEventArgs<VoiceAgentContract>["state"]): string {
    return colleaguePathForStream(this.path, state.colleaguePath);
  }

  /**
   * Ensure the colleague exists, is briefed, and BOTH forwarding lanes are
   * installed — status/replies coming here, the call's transcript going
   * there. Memoized per incarnation (reset on failure so the next call or
   * note retries); every append inside dedupes by idempotency key, so
   * re-running is a handful of no-op round trips.
   *
   * CALLED AT CALL START, not only at the first note: the transcript lane
   * is how the backend hears the conversation, and a call in which nobody
   * ever says `note_to_self` still deserves a record on the chat.
   */
  #ensureColleagueLink(state: ProcessEventArgs<VoiceAgentContract>["state"]): Promise<void> {
    if (this.#colleagueLink !== null) return this.#colleagueLink;
    const colleaguePath = this.#colleaguePath(state);
    /* Only the private voice-notes desk gets its debounce configured: an
     * existing chat named by the certificate has its own configuration and
     * a call must not rewrite it. */
    const configureDebounce = state.colleaguePath === null;
    const link = this.deps
      .withProject(async (project) => {
        const typedProject = project as {
          agents: {
            get(path: string): {
              create(payload?: object): Promise<unknown>;
              append(event: {
                type: string;
                idempotencyKey: string;
                payload: object;
              }): Promise<unknown>;
            };
          };
          streams: {
            get(path: string): {
              append(event: {
                type: string;
                idempotencyKey: string;
                payload: object;
              }): Promise<unknown>;
            };
          };
        };
        const agent = typedProject.agents.get(colleaguePath);
        await agent.create({});
        /*
         * THE STATUS LANE. The colleague already narrates itself —
         * `agent/summary-updated` is mandatory beside its work, and an
         * itx script can append its own — so forwarding that feed is
         * the whole feature: a copy-to-stream subscription on the
         * colleague's stream, transformed into this contract's
         * `colleague-status`, delivered here only when the colleague
         * actually does something. Push, not poll — a poll loop would
         * rebuild exactly the wakeup cost the dev-stats heartbeat was
         * deleted for. `start: "now"` because history is not status.
         */
        /* Keyed with the PATH and a REVISION, because the append dedupes by
         * key: an unchanged key on a stream whose colleague already exists
         * keeps the OLD subscription installed forever. Same name = the
         * subscription is replaced, so bumping the revision when the filter
         * or transform changes is the whole upgrade path — and a
         * certificate that re-points `colleaguePath` gets a fresh install
         * the same way. */
        await typedProject.streams.get(colleaguePath).append({
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: this.idempotencyKey(
            `colleague-status-subscription:${colleaguePath}:rev${COLLEAGUE_STATUS_SUBSCRIPTION_REV}`,
          ),
          payload: {
            name: "voice-colleague-status",
            description: "Forward the colleague's progress narration to the voice call.",
            filter: {
              eventTypes: [
                "events.iterate.com/agent/summary-updated",
                "events.iterate.com/agent/llm-request-requested",
                "events.iterate.com/capability-host/script-run-started",
                "events.iterate.com/capability-host/script-run-settled",
                /* The REPLY LANE rides this same subscription: without
                 * this entry the transform's web-message-sent branch is
                 * dead code and every colleague reply silently never
                 * leaves its stream — measured, embarrassingly, for an
                 * evening (the transform was extended; the filter was
                 * not). */
                "events.iterate.com/agents/web-message-sent",
              ],
            },
            receiver: {
              action: "copy-to-stream",
              receivingStreamPath: this.path,
              jsonataTransform: COLLEAGUE_STATUS_TRANSFORM,
              delivery: { start: "now", onFailingEvent: "halt" },
            },
          },
        });
        /* (The transcript lane — the other direction — is installed by
         * SETUP, whose batch surfaces a refused append as a failed setup;
         * see colleagueTranscriptSubscription for the silent-evening
         * incident that moved it there.) */
        /* Keyed context item — re-adding the key IS the update — but the
         * append dedupes by idempotency key, so the key carries a revision:
         * bump it when the brief's text changes, or old streams keep the
         * old words forever. */
        await agent.append({
          type: "events.iterate.com/agents/context-added",
          idempotencyKey: this.idempotencyKey("colleague-brief:v2"),
          payload: {
            content: COLLEAGUE_BRIEF,
            key: "voice-agent/colleague-brief",
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
            role: "system",
          },
        });
        if (configureDebounce) {
          // The platform births agents with a high (60s) debounce so a
          // config worker can shape them before their first turn. This
          // template has no config worker — the talk client is the
          // colleague's only configurator — so lowering the debounce here
          // is the done-configuring signal that releases the first turn.
          await agent.append({
            type: "events.iterate.com/agent/configured",
            idempotencyKey: this.idempotencyKey("colleague-config"),
            payload: { config: { llmRequestDebounceMs: 250 } },
          });
        }
      })
      .catch((error: unknown) => {
        if (this.#colleagueLink === link) this.#colleagueLink = null;
        throw error;
      });
    this.#colleagueLink = link;
    return link;
  }

  /**
   * THE SLOW HALF. Make sure the colleague link stands (see
   * #ensureColleagueLink) and send the note as a fire-and-forget message.
   * There is deliberately NO reply handling here: every chat message the
   * colleague ever sends comes back as a durable `colleague-note` event
   * through the copy-to-stream subscription the link installed, and the
   * processEvent arm reads it into whichever call is live — see the header
   * block for the ask() flow this replaced and the three ways it lost
   * replies.
   */
  #noteToColleague(
    note: string,
    state: ProcessEventArgs<VoiceAgentContract>["state"],
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
  ): void {
    /*
     * THE OPENING STATUS, appended by THIS side. The colleague's first
     * narration lands only after its first model turn settles — 30-90
     * measured seconds of dead air in which "what's it doing?" had no
     * status to relay and a reconnect's briefing had no mid-task line, so
     * it re-sent the note. Dispatching a note is itself a status. Its own
     * background closure, so a refused append cannot cost the note. Quiet:
     * the model just SAID it sent the note; the whisper is enough.
     */
    /* The key is minted BEFORE the closure: a retried closure must retry
     * the SAME append, not mint a sibling status per attempt. */
    const openingStatusKey = this.idempotencyKey(`note-sent:${crypto.randomUUID()}`);
    runInBackground(() =>
      append({
        type: "events.iterate.com/voice-agent/colleague-status",
        idempotencyKey: openingStatusKey,
        payload: { activity: "picking up a note from the frontend", waitingFor: null, quiet: true },
      }),
    );
    runInBackground(async () => {
      try {
        await this.#ensureColleagueLink(state);
        await this.deps.withProject(async (project) => {
          /* withProject hands over the project root untyped: its generated
           * client type lives in apps/os and a config-repo template cannot
           * import it, so the shape is asserted to exactly the calls made
           * here — a wrong assertion fails loudly at the RPC boundary. */
          const typedProject = project as {
            agents: { get(path: string): { message(input: string): Promise<unknown> } };
          };
          /*
           * The antidote rides IN the note, right beside the poison: the
           * platform prepends its reply-routing label to this same message,
           * and a rule three system items away loses to an instruction on
           * the line being read. See COLLEAGUE_BRIEF for the incident.
           */
          await typedProject.agents
            .get(this.#colleaguePath(state))
            .message(
              `${note}\n\n` +
                `(Reply with await itx.chat.sendMessage("…") on this stream — that is the ` +
                `only channel the voice hears. The 'To reply to /agents/voice/…' routing ` +
                `line above is wrong here: that path is not an agent; do not message it or ` +
                `create it.)`,
            );
        });
      } catch {
        /* A lost note is a colleague who was never asked. */
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
   * What a face-rendering board's 10 Hz poll reads. The boards have been
   * polling this the whole time — v2 simply had nothing to say until now.
   * The face rides the dial: a call that ended is a mouth that shut, and
   * the firmware treats a missing face as nothing to render.
   *
   * A POLL, NOT A LIVESTATE SUBSCRIPTION, and not by preference: the value
   * is exactly what liveState exists to diff, but a userspace facet's
   * liveState node serves the runner's committed FOLD — `assembleLive` in
   * the SDK's stream-processor-registry publishes `currentState`, and the
   * `getLiveState` override that could project a runtime bag instead is a
   * hook `StreamProcessorFacet.createHost` never exposes to userspace. The
   * day that seam opens, `face.read()` is the value to put through it and
   * this poll becomes the compatibility path.
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

  /**
   * What the listener has HEARD of the answer, read off the pacer's own
   * schedule: everything handed to the device, minus what still sat unplayed
   * in its buffer — which a clear is about to throw away — minus the fixed
   * lag between the hand-over and the cone (DEVICE_START_LAG_MS: delivery,
   * DMA ring, start-up fill — audio a clear kills before it ever plays). The
   * schedule models the WORST-CASE lead, so this can only understate; the
   * floor at zero covers an answer that never started.
   */
  #heardMsFromSchedule(dial: Dial, nowAtFacetMs: number): number {
    /* A SCHEDULE THAT RAN OUT LONGER THAN THE START LAG AGO HAS NO CONE
     * STILL MOVING: everything handed over has played, whole, so heard-ms
     * is `sentMs` itself and the subtractions below have nothing to
     * correct. Without this arm the lag subtraction manufactured an
     * interruption out of every press that FOLLOWED a completed answer —
     * the device had been silent for seconds and the model was still sent
     * a truncate slicing the answer's last 150 ms off plus a false "the
     * user interrupted, they heard only this much" note, on every ordinary
     * turn (measured on the wire against a fully-played reply). The lag
     * models a cut through audio STILL PLAYING; it must never shorten an
     * answer the room heard end. An answer barged before anything was
     * handed over still repairs honestly here: its `sentMs` is zero, which
     * is exactly what was heard. */
    if (nowAtFacetMs - dial.deviceBufferEmptyAtFacetMs >= DEVICE_START_LAG_MS) {
      return Math.max(0, Math.floor(dial.answer.sentMs));
    }
    const unplayedMs = Math.max(0, dial.deviceBufferEmptyAtFacetMs - nowAtFacetMs);
    return Math.max(0, Math.floor(dial.answer.sentMs - unplayedMs - DEVICE_START_LAG_MS));
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
   *   STREAMING — the settle must WAIT. Sent beside the cancellation it
   *   races the item's own finalization (observed live: the ack and the
   *   response's `done` shared a millisecond, and the model still
   *   remembered the full count). So the repair is armed on the dial and
   *   settled at the response's `response.done`; the answer moves to
   *   "cancelled" here too, which is what deafens the residue. What this
   *   method deliberately does NOT send is `response.cancel`: #bargeAnswer
   *   owns that decision, and only the press ever says yes.
   *
   *   SETTLED — the repair settles immediately; nothing finalizes late.
   */
  #repairBargedAnswerMemory(
    dial: Dial,
    heardMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    if (!dial.ready || dial.socket === null) return;
    /* One frame of slack (25 ms) so a fully-played answer is never
     * "truncated" to its own length by rounding — see the method doc. */
    const repair: Repair | null =
      dial.answer.itemId !== null && heardMs + 25 < dial.answer.receivedMs
        ? {
            itemId: dial.answer.itemId,
            contentIndex: dial.answer.contentIndex,
            /* WHOLE milliseconds, floored ONCE where the number becomes the
             * repair: the provider rejects a fractional audio_end_ms
             * ("expected an integer" — seen live when the onset-lag
             * subtraction went fractional), and the note's prefix filter
             * reads this same field, so truncate and note cannot disagree
             * about the boundary. */
            audioEndMs: Math.floor(heardMs),
          }
        : null;
    if (repair !== null) dial.answer.itemId = null;
    if (dial.answer.phase === "streaming") {
      dial.answer.phase = "cancelled";
      if (repair !== null) dial.pendingRepair = repair;
      return;
    }
    if (repair !== null) this.#settleRepair(dial, repair, append);
  }

  /**
   * Send one repair, whole: the truncate where it works, then the note that
   * is ALWAYS the recall half. Two verbs, one action — its two callers (the
   * immediate settled-answer path and the deferred `response.done` settle)
   * used to spell the pair separately, and a pair spelled twice is a pair
   * that drifts.
   *
   * THE TRUNCATE, where it works: `conversation.item.truncate` at heard-ms
   * trims the item's audio AND transcript. Where it does not (grok — see
   * the PROVIDERS table), NOTHING goes out and the note is the entire
   * repair. Not for want of trying: truncate is a silent no-op there and
   * delete answers "Item not found" for assistant items, so a verb would
   * only decorate every barge with a provider error.
   *
   * THE NOTE: truncation deletes the item's transcript wholesale, and a
   * model asked "how far did you get" over audio-only memory swings to "I
   * never started" (measured live). The note carries the heard PREFIX —
   * the transcript segments that had arrived by heard-ms, consumed here so
   * a second settle cannot repeat them — so recall becomes exact instead
   * of confabulated in either direction. A system item: context, never
   * speech.
   */
  #settleRepair(
    dial: Dial,
    repair: Repair,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    if (dial.truncates) {
      this.#sendControl(
        dial,
        {
          type: "conversation.item.truncate",
          item_id: repair.itemId,
          content_index: repair.contentIndex,
          audio_end_ms: repair.audioEndMs,
        },
        append,
      );
    }
    const segments = dial.answer.transcript;
    dial.answer.transcript = [];
    const heardPrefix = segments
      .filter((segment) => segment.atAnswerAudioMs <= repair.audioEndMs)
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
      append,
    );
  }

  /**
   * THE FLOOR CHANGED HANDS: kill the answer everywhere, then repair the
   * model's memory of it.
   *
   * One method because its three callers — the button, a VAD onset on a
   * provider that cancelled server-side, and a confirmed tentative onset —
   * used to be three hand-copied sites, and the copies drifted into two
   * real bugs. None of them reset `endsWhenQueueDrains`, so a press on a
   * SETTLED answer mid-drain left the pacer to mark the end of an answer
   * the press had just erased (the exact stale marker the Answer docstring
   * records as a prior bug class). And neither VAD path un-decided a
   * pending hang-up, so an open-mic listener — whose ONLY barge is VAD —
   * talked past the goodbye, got the follow-up answered, and the call hung
   * up anyway. Every barge now does both by construction: taking the floor
   * back IS un-deciding the hang-up ("the user talked past the goodbye" —
   * the model already heard "hanging up" as its tool output; the
   * transcript shows what happened next, the truth).
   *
   * `heardMs` is the CALLER's, read before this method zeroes the pacer's
   * schedule: sent audio minus what still sat unplayed in the device's
   * buffer when the clear threw it away. A confirmed onset passes the
   * number frozen at its clear.
   *
   * `cancel` — whether to also tell the provider to STOP GENERATING. Only
   * the press says true: turn_detection is null in push-to-talk, so no
   * provider VAD will ever cancel for a button. The VAD callers say false
   * — OpenAI's server_vad `interrupt_response` (pinned true in our
   * session.update) already cancelled server-side at the onset, and grok
   * drew an error every time a VAD-triggered cancel was tried. Gated on a
   * STREAMING answer either way: without the gate every ordinary press (no
   * answer playing, which is most of them) drew a "nothing to cancel"
   * error from the provider.
   */
  #bargeAnswer(
    dial: Dial,
    heardMs: number,
    decidedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    cancel: boolean,
  ): void {
    dial.hangUpAfterAnswerDrains = null;
    dial.face?.barge(decidedAtFacetMs);
    /* Read BEFORE the repair moves a streaming answer to "cancelled". */
    const responseWasStreaming = dial.answer.phase === "streaming";
    this.#dropAnswerInFlight(dial, decidedAtFacetMs, append);
    /* An answer that died unheard must not mark an end: the drain marker
     * would tell the device a turn finished that the barge just erased. */
    dial.answer.endsWhenQueueDrains = false;
    this.#repairBargedAnswerMemory(dial, heardMs, append);
    if (cancel && responseWasStreaming) {
      this.#sendControl(dial, { type: "response.cancel" }, append);
    }
  }

  /**
   * A tentative onset proved itself: a turn was committed — the ONE
   * confirming arm is `input_audio_buffer.committed`; `response.created`
   * deliberately is not one, see that arm. The retained tail dies now and
   * the memory repair runs with the heard-ms frozen at the onset's clear,
   * via #bargeAnswer — so a confirmed turn also un-decides a pending
   * hang-up, because it IS the user taking the floor back. No-op when
   * nothing is held, which is every commit outside a barge. The device
   * needs no second clear (it was silenced at the onset), except when a
   * retraction let frames slip out in the stopped-to-committed gap — and
   * then #dropAnswerInFlight's watermark sends exactly one.
   */
  #confirmTentativeOnset(dial: Dial, append: ProcessEventArgs<VoiceAgentContract>["append"]): void {
    const onset = dial.tentativeOnset;
    if (onset === null) return;
    dial.tentativeOnset = null;
    this.#bargeAnswer(dial, onset.heardMs, this.deps.nowAtFacetMs(), append, false);
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
    decidedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
  ): void {
    dial.speakerQueue = [];
    dial.deviceBufferEmptyAtFacetMs = 0;
    this.#clearDeviceSpeaker(dial, decidedAtFacetMs, append);
    /* AND THE NEXT REAL FRAME SAYS IT AGAIN. The clear above is one empty
     * frame on a lane that documents its own drops; lose that single append
     * and nothing ever re-asserts the flush — the device plays the dead
     * answer's whole buffered tail behind the barge ("it kept counting").
     * Every frame after this line belongs to a REPLACING answer, so the
     * first one carries the clear too, which is the firmware's own doctrine
     * for the signal: the drop rides the first chunk of the answer that
     * replaces the one it kills, and cannot be lost without losing the
     * replacement itself. NOT armed by #clearDeviceSpeaker, because its
     * other caller — a tentative onset — holds a tail that may RESUME, and
     * a resumed frame carrying a clear would flush the silence the hold
     * just bought. */
    dial.clearSpeakerBufferBeforeNextFrame = true;
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
    decidedAtFacetMs: number,
    append: ProcessEventArgs<VoiceAgentContract>["append"],
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
   * speaker buffer from overflowing. Audio plays at one second per second, so
   * a sender that runs at the same rate can never make the backlog grow: the
   * board drains exactly as fast as we fill it. What it holds is therefore
   * bounded by the head start we deliberately give it —
   * MAX_DEVICE_SPEAKER_BACKLOG_BYTES, one constant, in the unit the board runs
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
    append: ProcessEventArgs<VoiceAgentContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentContract>["runInBackground"],
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
            /* The frame is base64 and goes out verbatim; its BYTE length —
             * what every piece of pacing arithmetic below is denominated in
             * — is read off the string without decoding it. */
            const frameBytes = base64ByteLength(frame);
            /*
             * THE WHOLE SAFETY PROOF, IN ONE INEQUALITY. A frame goes only when
             * what the device already holds, plus this frame, fits the budget —
             * so the backlog is never above it. Bytes rather than a frame count
             * because the tail of a Grok delta is a partial frame, and a count
             * would mis-size exactly that one.
             */
            const overflowBytes =
              (dial.deviceBufferEmptyAtFacetMs - nowAtFacetMs) * PCM16_BYTES_PER_MS +
              frameBytes -
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
            dial.deviceBufferEmptyAtFacetMs += frameBytes / PCM16_BYTES_PER_MS;
            dial.answer.sentMs += frameBytes / PCM16_BYTES_PER_MS;
            /*
             * THE FACE FOLDS AT SEND TIME, on the frame the device is about
             * to play — the cadence the retired per-frame viseme lane had.
             * Folded at ingest it raced a burst-delivered answer to its
             * final shape and the mouth stood still for the playout; folded
             * here it leads playout only by the device's small backlog. The
             * decode is the one this lane pays for a face, and only when a
             * face is rendering — which is why `visemes` is certificate
             * data rather than always-on.
             */
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
            /* The mouth closes WITH the marker, not at the provider's done:
             * SIL at ingest shut it seconds before the speech finished. */
            dial.face?.answerAudioDone(this.deps.nowAtFacetMs());
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
          /* THE MODEL HUNG UP, and the drain point is where that settles — the
           * same place lastFrameOfAnswer is decided, for the same reason: it is
           * where the answer is knowable. The device holds the whole goodbye;
           * the pacer's own deadline says when it finishes PLAYING. Sleep that
           * off, re-check (a press during playout un-decides it), then one
           * atomic append; the ordinary end-requested machinery does the rest.
           * A hang-up behind a still-STREAMING response is not settleable yet —
           * `response.done` re-triggers the pacer and it settles then. */
          if (dial.hangUpAfterAnswerDrains !== null && dial.answer.phase !== "streaming") {
            await this.deps.sleep(
              Math.max(0, dial.deviceBufferEmptyAtFacetMs - this.deps.nowAtFacetMs()),
            );
            if (this.#dial !== dial) return;
            /* A LISTENER ANSWERING THE GOODBYE lands exactly here: the
             * playout sleep is the goodbye's last device-lead seconds, the
             * likeliest place to talk past it, and settling before the
             * onset's committed can arrive would hang up mid-user-turn. An
             * UNRETRACTED hold sends the settle back to the top, where the
             * pause gate parks the pacer — the confirm un-decides the
             * hang-up (#bargeAnswer) and a retraction resumes, re-runs this
             * branch, and settles it. Unretracted holds ONLY: the onset
             * zeroed the schedule, so continuing for a retracted-but-held
             * one too would spin this loop through sleep(0) for ever. */
            if (dial.tentativeOnset !== null && !dial.tentativeOnset.retracted) continue;
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

/**
 * The credential follows the HOST, never the flag: a test seam pointing at
 * a fake gets no secret at all, whichever provider it fakes. THE ONE COPY
 * of the host→secret rule — the dial spends it and setup's gate demands it,
 * so the two cannot disagree about which secret a stream actually needs.
 * (Setup used to hard-require /secrets/xai whatever the provider: a fresh
 * project with provider "openai" failed setup over a credential its dial
 * would never send, and talk2 carried a workaround creating it.)
 */
function secretForHost(hostname: string): string | null {
  if (hostname === "api.x.ai" || hostname.endsWith(".x.ai")) return XAI_SECRET;
  if (hostname === "api.openai.com") return OPENAI_SECRET;
  return null;
}

export async function dialProviderSocket(
  provider: VoiceProvider,
  baseUrl: string | null,
  model: string,
): Promise<WebSocket | null> {
  const target = new URL(baseUrl ?? PROVIDERS[provider].url);
  target.searchParams.set("model", model);
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

/*
 * INSTALLING THIS THING, AND WHY IT IS ITS OWN ENTRYPOINT.
 *
 * The first cut's `setupVoiceAgent` was four hundred lines because it also
 * derived a prompt from the project's live capabilities, installed it as an
 * agent brief, and proved the running processor folded THAT brief and not an
 * older one. This one has no capabilities to describe, so the prompt is just
 * a string the caller passes — and the whole apparatus collapses into: append
 * the birth certificate, install the subscription, and hold the platform's
 * fold-through barrier until the facet has folded both.
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
    console.error("voice-agent RPC stub disposal failed", { error, label });
  }
}

/**
 * Where the loader finds this facet: this file, in the project's config repo.
 *
 * The key names the durable worker, so it is load-bearing rather than
 * cosmetic: a second class claiming the same key would be two classes
 * claiming one identity.
 */
function voiceAgentFacetRef(streamPath: string) {
  return {
    className: "VoiceAgentFacet",
    durableWorkerKey: "voice-agent-facet",
    path: streamPath,
    source: {
      createWorker: {
        entryPoint: "voice-agent.ts",
        files: { repoPath: "/repos/config", type: "repo" },
      },
    },
    type: "stateful",
  } satisfies StatefulDynamicWorkerRef;
}

/** How long setup's fold-through barrier waits. A cold facet build is most of it. */
const WARMUP_DEADLINE_MS = 90_000;

/** What setup needs to know to put this agent on a stream. */
export interface SetupVoiceAgentOptions {
  /** The conversation stream. A fresh /agents/voice/* path is generated when omitted. */
  streamPath?: string;
  /**
   * Dial THIS instead of x.ai, for a deterministic test.
   *
   * NO CREDENTIAL FOLLOWS IT — see {@link secretForHost}: a host that is no
   * known provider's gets no Authorization header and no setup gate.
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
  tools?: z.input<typeof VoiceTool>[];
  /** Install the subscription under a fresh key even if an identical one exists. */
  reinstall?: boolean;
}

/** What setup did, in enough detail for a caller to print it. */
export interface SetupVoiceAgentResult {
  streamPath: string;
  /** Setup's own clock: batch appended to fold-through proven. Cold build included. */
  warmMs: number;
}

export default class VoiceAgentEntrypoint extends IterateWorkerEntrypoint {
  /**
   * Prove this guest is built, running, and can reach its own project.
   *
   * A dynamic worker is built lazily on the first call into it, so that first
   * call carries a cold build and a build failure surfaces in whatever the
   * caller happened to be doing. Having a call whose only job is to be the
   * first one means a caller can pay for the build deliberately.
   *
   * That is the WHOLE job, which the reachable projectId proves. It used to
   * also report `xaiSecretReady` — a secrets.__describe round trip per poll
   * that nothing anywhere gated on (talk2 destructured it and printed only
   * the projectId), and the wrong secret besides for an openai stream.
   * Setup is where the right secret is demanded, per provider.
   */
  async health(): Promise<{ ok: true; projectId: string; buildCacheKey: string }> {
    const project = await this.itx;
    return {
      ok: true,
      projectId: await project.projectId,
      /* Which build answered — comparable against the facet's runtime bag,
       * because the stateless entrypoint and the stateful facet have been
       * observed running different builds. The cast: ITERATE_WORKER_VERSION
       * is injected by the platform's worker loader at load time, so the
       * guest's generated env type cannot know it. */
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
    /* Demand exactly the secret the certificate's dial will spend — the one
     * host→credential rule in secretForHost, shared with the dial itself. A
     * providerBaseUrl seam resolves to no secret and gets no gate, matching
     * "a test seam gets no credential". */
    const dialTarget = new URL(
      options.providerBaseUrl ?? PROVIDERS[options.provider ?? "openai"].url,
    );
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
       * BIRTH AND CONFIGURATION, SPLIT — the explicit-birth doctrine applied
       * to this agent at last. `created` is existence only, under a key with
       * nothing but the stream path in it: appended once for the life of the
       * stream, and a second setup run finds the key taken and appends
       * nothing, because a second birth is corruption rather than an update.
       *
       * The configuration is an ordinary event. Which provider to dial and
       * what to say the model is are per-stream settings that must survive
       * the eviction a per-call argument would not, so they ride `configured`
       * — keyed per SETUP RUN, so a morning that alternates mock, real,
       * mock, real applies each switch. The first cut keyed its config on
       * content ALONE and by the second `real` the key was taken, nothing
       * was appended, and the fold still named a tunnel that had closed an
       * hour before.
       */
      /* SetupVoiceAgentOptions IS the configured payload plus the two
       * setup-only keys — the rest-destructure says so, where a lattice of
       * eight conditional spreads used to. An explicitly-undefined value
       * survives the rest but vanishes in JSON.stringify, at the content
       * hash and on the wire alike, so the appended payload is
       * byte-identical either way. */
      const { streamPath: _streamPath, reinstall: _reinstall, ...configPayload } = options;
      /*
       * ONE IDENTITY FOR THIS SETUP: the setup id makes every run an
       * OCCURRENCE rather than a value, so the configuration is re-applied
       * however often the same content recurs. (A content hash rode this
       * key once, decoratively — the fresh setupId already made every key
       * new; the subscription key below is where content-dedupe is real.)
       */
      const setupId = crypto.randomUUID();
      const subscriptionPayload = {
        name: VoiceAgentContract.slug,
        description: "Wake the voice-agent facet in this stream's own Durable Object.",
        /* DERIVED from the contract, never hand-written: delivery is this filter
         * INTERSECTED with `consumes`, so a type in one list and not the other is
         * silently never delivered, and two hand-maintained copies of one list
         * drift. Adding a type to `consumes` is now the whole change. */
        filter: { eventTypes: [...VoiceAgentContract.consumes] },
        receiver: {
          action: "facet-processor",
          source: { kind: "userspace", worker: voiceAgentFacetRef(streamPath) },
        },
      };
      const subscriptionKeyPrefix = `voice-agent/subscription:${streamPath}`;
      /* THE TRANSCRIPT LANE rides the setup batch: the facet cannot append
       * a subscription to its own stream (the RPC re-enters its own Durable
       * Object), and setup already owns this stream's subscriptions. The
       * colleague path is a pure function of the certificate, so setup
       * knows the target without asking anybody. Skipped only when the
       * colleague is explicitly off. */
      const transcriptSubscriptionPayload =
        options.colleague === false
          ? null
          : colleagueTranscriptSubscription(
              streamPath,
              colleaguePathForStream(streamPath, options.colleaguePath ?? null),
            );
      const transcriptKeyPrefix = `voice-agent/transcript-subscription:${streamPath}`;
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
        ...(transcriptSubscriptionPayload === null
          ? []
          : [
              {
                type: "events.iterate.com/stream/subscription-configured",
                idempotencyKey: options.reinstall
                  ? `${transcriptKeyPrefix}:reinstall:${crypto.randomUUID()}`
                  : `${transcriptKeyPrefix}:${contentHash(transcriptSubscriptionPayload)}`,
                payload: transcriptSubscriptionPayload,
              },
            ]),
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
       * (worker-loader.ts: ITERATE_WORKER_VERSION); surfacing it is the only
       * way to tell which build a LIVE facet is running. The cast exists
       * because the key is loader-injected at load time, so the guest's
       * generated env type cannot know the field. */
      buildCacheKey: String(
        (this.env as Record<string, unknown>).ITERATE_WORKER_VERSION ?? "unknown",
      ),
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
// probe7 1787773120
