// DOES THE SPEAKER LANE PACE, ON A REAL DEPLOYMENT, WITH A PROVIDER THAT SAYS
// EXACTLY WHAT IT WAS TOLD TO?
//
//   doppler run --config preview_3 -- pnpm cli voicelab paced \
//     --project marginal-1 --answer-seconds 90
//
//   doppler run --config preview_3 -- pnpm cli voicelab paced \
//     --project marginal-1 --answer-seconds 10 --turns 4
//
// The in-process proof of the same claim already exists
// (`config-repo/voice-agent.count-to-100.test.ts`): the real facet, a
// simulated provider, a simulated board, no network. This is that proof with
// the network put back — a deployed OS worker, a Durable Object, an ephemeral
// delivery lane and a WebSocket across the Atlantic — and it exists because
// every one of those is a place the pacing could be undone without any test
// noticing. Delivery could coalesce a paced answer back into a burst; the DO
// could evict mid-answer; the client's socket could hold frames and release
// them in a lump.
//
// TWO HALVES, BOTH CONTROLLED.
//
//   * The provider is `fake-grok.ts`, published on a captun URL that a
//     Cloudflare worker can dial, told to say N seconds and nothing else. A
//     real provider varies its answer length by tens of percent, which makes
//     "did everything arrive?" unanswerable — there is no left-hand side.
//     `setupVoiceAgent({ providerBaseUrl })` points the facet at it, and no
//     credential follows the URL (see `voice-agent.provider-url.test.ts`).
//   * The listener is the SAME modelled board the in-process proof uses: a
//     ten-second ring that REFUSES writes when it is full and counts drains
//     that found it dry. That refusal is the whole point. A plain recording
//     accepts everything, so a run that lost a second of speech produces a
//     file that is simply a second shorter and sounds perfect.
//
// THE ONE NUMBER THAT MATTERS IS THE SPREAD: how long the answer took to
// arrive. Ninety seconds of speech handed over in five is the bug this whole
// redesign undid, and it is invisible in every other measurement — all the
// bytes arrive, nothing is refused by a ring that is big enough, and the
// recording plays back perfectly. Only the clock says it went wrong.
//
// The board is driven from the RECORDED ARRIVAL TRACE rather than live. A
// twenty-millisecond ticker in a Node process that is also decoding base64 and
// servicing a WebSocket measures Node's timer jitter as well as the server's
// pacing; replaying the trace afterwards measures only what arrived and when.
import process from "node:process";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DynamicWorkerCapability } from "iterate/sdk";

import { connectProject, deviceCapability, type VoicelabConnectOptions } from "./connect.ts";
import { installVoiceAgent } from "./deploy.ts";
import { startFakeGrok } from "./fake-grok.ts";
import { closeAndDisposeRpcHandle, discardRpcResult, withRpcResult } from "./rpc-ownership.ts";
import { voiceAgentEntrypointRef } from "./voice-agent-ref.ts";
import { DEFAULT_SPEAKER_LIMITS, MULAW_BYTES_PER_MS } from "./config-repo/speaker.ts";

/** Options for `pnpm cli voicelab paced`. */
export interface PacedOptions extends VoicelabConnectOptions {
  /**
   * The conversation stream. A fresh one every run by default, and that is the
   * right default: the birth certificate naming the mock is folded per stream,
   * so reusing a path means inheriting whichever provider the last run pointed
   * it at — including, if that run was `talk`, the real one.
   */
  streamPath?: string;
  /** Seconds of speech the mock says per turn. Ninety is the count to 100. */
  answerSeconds?: number;
  /** Consecutive turns on ONE call. More than one proves it stays one call. */
  turns?: number;
  /**
   * Ceiling on the wait for one answer to finish arriving.
   *
   * Defaults to the answer's own length plus half again plus thirty seconds:
   * enough for a cold dial and a slow tunnel, short enough that a lane which
   * has stopped sending is reported rather than waited on for ever.
   */
  settleMs?: number;
  /** Silence between turns. Must stay under the 60 s idle deadline. */
  gapMs?: number;
  /** Name the captun tunnel instead of taking a generated one. */
  tunnelName?: string;
  /** Mirror the provider's own log to stderr as it happens. */
  verbose?: boolean;
  /**
   * Drive a PHYSICAL BOARD instead of appending the press from here, and judge
   * the run on ITS counters as well as on this process's arrival trace.
   *
   * The modelled board is a model. It is a good one — it refuses writes when
   * full and counts drains that found it dry, which is more than a recording
   * can do — but it is fed from a trace taken in a Node process on a laptop,
   * and everything between that laptop and the board's converter is untested
   * by it: the device's own delivery lane, its inbox slot, its base64 decode,
   * its ring, its I2S clock. The board keeps a census of exactly those
   * (`spkFrames`, `spkOverflow`, `spkSoftDryRefills`, `spkStarvedMs`) and it
   * is the only witness that cannot be wrong about them.
   *
   * The value is the capability name — `stackchan`, `waveshare`, … — and the
   * stream is then the board's OWN (`health().conversation`), because a board
   * listens to one path and pressing anywhere else proves nothing.
   */
  board?: string;
  /** How long to hold the board's talk button. The mock ignores what it hears. */
  pressMs?: number;
  /** Skip the mock entirely and dial x.ai, for the count to one hundred. */
  real?: boolean;
  /**
   * SAY THIS OUT LOUD, through the Mac's own speaker, while the button is held.
   *
   * Nothing is injected past the hardware: the words leave a speaker, cross a
   * room and arrive at the board's microphone, which is the only way to prove
   * the uplink a listener actually uses. Multiple turns cycle through these in
   * order, separated by `|`.
   */
  say?: string;
  /**
   * A word the answer's transcript must contain.
   *
   * The counters cannot tell "counted to one hundred" from "counted to
   * sixty-three and was cut off": ninety seconds of audio that stops mid-count
   * reads perfect on every one of them. `--expect hundred` is what closes that.
   */
  expect?: string;
}

const PTT_START = "events.iterate.com/voice-agent/ptt-start";
const PTT_END = "events.iterate.com/voice-agent/ptt-end";
const SPK_FRAME = "events.iterate.com/voice-agent/spk-frame";
const WARMUP = "events.iterate.com/voice-agent/warmup";

/** 16 kHz mono PCM16: 32 bytes per millisecond, exactly. */
const PCM_BYTES_PER_MS = 32;
/** The wire frame both consumers on the device require, to the byte. */
const FRAME_BYTES = 640;
/** The board's ring, at the size the profile gives it: ten seconds. */
const RING_BYTES = 10_000 * PCM_BYTES_PER_MS;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const run = promisify(execFile);

/**
 * A converter that takes one frame every 20 ms and does not care whether you
 * had one.
 *
 * Copied deliberately from `config-repo/voice-agent.count-to-100.test.ts` and
 * NOT imported from it: that file is the in-process proof's own device model,
 * and the two are the same claim measured at two levels. If they ever have to
 * differ — a deployed run sees jitter an in-process one cannot — they must be
 * able to, without one edit silently changing what the other asserts.
 */
class Board {
  buffered = 0;
  /** Bytes refused because the ring was full — audio the listener lost. */
  refusedBytes = 0;
  /** Drains that found the ring dry AFTER playback had begun — heard as gaps. */
  underruns = 0;
  /** Bytes actually handed to the converter. */
  playedBytes = 0;
  /** Peak occupancy, which is what the ring has to be sized for. */
  peakBuffered = 0;
  #playing = false;
  #done = false;

  write(pcm: number): void {
    if (this.buffered + pcm > RING_BYTES) {
      this.refusedBytes += pcm;
      return;
    }
    this.buffered += pcm;
    this.peakBuffered = Math.max(this.peakBuffered, this.buffered);
    this.#playing = true;
  }

  /** `drop`: everything held belongs to an answer that is over. */
  clear(): void {
    this.buffered = 0;
  }

  /** `last`: the fence may be released once what is held has played out. */
  finish(): void {
    this.#done = true;
  }

  get drained(): boolean {
    return this.#done && this.buffered === 0;
  }

  /** One converter period. */
  tick(): void {
    if (!this.#playing) return;
    if (this.buffered < FRAME_BYTES) {
      if (!this.drained) this.underruns++;
      return;
    }
    this.buffered -= FRAME_BYTES;
    this.playedBytes += FRAME_BYTES;
  }
}

/**
 * THE BOARD'S OWN CENSUS OF THE SPEAKER LANE.
 *
 * Every field is a `uint32_t` published by `health_json` in
 * `apps/kit/firmware/components/voice/src/voice_loop.c`, and the four that
 * matter here are exactly the four assertions this proof makes:
 *
 *   - `spkFrames`  — 640-byte PCM frames the device decoded and handed on, so
 *     × 20 ms is what it RECEIVED. Compared against what the provider sent,
 *     this is "everything sent arrived" with the device as the witness.
 *   - `spkOverflow` — writes the ring refused. The one number a recording can
 *     never show: a frame refused on arrival is not a frame that went missing.
 *   - `spkSoftDryRefills` — a drain that found the ring dry with audio
 *     arriving just after, i.e. the answer was still in progress.
 *   - `spkStarvedMs` — the audible-failure gate the firmware itself names:
 *     milliseconds the ring was empty while playing.
 *
 * The rest are the ways audio can vanish WITHOUT touching those, and every one
 * of them has silenced a board at least once, so they are all read.
 */
const DEVICE_COUNTERS = [
  "spkFrames",
  "spkPlayed",
  "spkOverflow",
  "spkSoftDryRefills",
  "spkStarvedMs",
  "spkSoftDryTicks",
  "spkDecodeFailures",
  "spkBadFrames",
  "spkDiscarded",
  "spkWriteFailures",
  /*
   * THE ONLY OTHER BUCKET A RECEIVED FRAME CAN END UP IN, and the one that
   * makes the arithmetic close. A frame the device judges itself late for is
   * skipped rather than played — deliberate, bounded, and still 20 ms the
   * listener does not hear, so it is counted here rather than forgiven.
   */
  "spkCatchup",
  "spkWrites",
  "spkAnswerStarts",
  "spkSupersededMidplay",
  "spkMarginMinMs",
  "spkLagMaxMs",
  "framesSent",
  "batches",
  "micCaptured",
] as const;

type DeviceCensus = Record<(typeof DEVICE_COUNTERS)[number], number>;

/** The board's capability surface, as this driver uses it. */
interface BoardCapability {
  health(): Promise<Record<string, unknown>>;
  pushToTalk: { start(): Promise<unknown>; stop(): Promise<unknown> };
  /* `end`, not `hangUp`: the firmware mounts `{"conversation","end"}`
   * (components/capabilities/src/conversation.c), and a call to a name the
   * board does not have fails as "unknown device capability" — which reads
   * exactly like an unplugged device. both scripts asked for `hangUp` until now. */
  conversation: { start(): Promise<unknown>; end(): Promise<unknown> };
}

/**
 * Read the board's health, riding over the remount a fresh call causes.
 *
 * Adopting a conversation genuinely takes the capability away for a second or
 * two. That is the handshake working, and a proof that reported it as a dead
 * board would be reporting on itself.
 */
async function boardHealth(
  board: BoardCapability,
  attempts = 12,
): Promise<Record<string, unknown>> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await board.health();
    } catch (error) {
      last = error;
      await sleep(1_000);
    }
  }
  throw new Error(`the board stopped answering health(): ${String(last)}`);
}

function census(health: Record<string, unknown>): DeviceCensus {
  const counters = {} as DeviceCensus;
  for (const name of DEVICE_COUNTERS) counters[name] = Number(health[name] ?? 0);
  return counters;
}

function censusDelta(before: DeviceCensus, after: DeviceCensus): DeviceCensus {
  const delta = {} as DeviceCensus;
  for (const name of DEVICE_COUNTERS) delta[name] = after[name] - before[name];
  return delta;
}

/** One health poll taken while the answer was still arriving. */
interface DeviceSample {
  at: number;
  frames: number;
  played: number;
  /** Frames thrown away, which is a WHEN question before it is a why. */
  discarded: number;
  /** Answers begun, i.e. `drop` chunks the device acted on. */
  answerStarts: number;
}

/** One speaker event as it reached this process. */
interface Arrival {
  /** Wall clock, here, on arrival. The only thing a spread can be made of. */
  at: number;
  /** Decoded mu-law length. Sixteen bytes is a millisecond of speech. */
  mulawBytes: number;
  drop: boolean;
  last: boolean;
  conversationId: string;
}

/** What one turn's arrival trace did to a board. */
interface TurnVerdict {
  turn: number;
  /** Speaker events this turn: ~3/s, not ~50/s. */
  events: number;
  /** Playback milliseconds handed to the device, from the audio itself. */
  receivedMs: number;
  /** First arrival to last. THE number: it must be the answer's own length. */
  spreadMs: number;
  /** From letting go of the button to the first frame of the answer. */
  firstFrameMs: number | null;
  refusedBytes: number;
  underruns: number;
  /** Peak ring occupancy in playback ms — the contract with the firmware. */
  peakBufferedMs: number;
  drops: number;
  lasts: number;
  /** Calls these frames belonged to. More than one is a re-dial mid-turn. */
  conversations: string[];
  problems: string[];
  /** The same four questions, answered by the hardware. Absent with no board. */
  device?: DeviceVerdict;
}

/** What the board itself says happened to this turn. */
interface DeviceVerdict {
  /** `spkFrames` × 20 ms: playback the DEVICE decoded and handed to its ring. */
  receivedMs: number;
  /** `spkPlayed` × 20 ms: playback its converter actually took. */
  playedMs: number;
  /** Refused at the door, in playback ms. */
  refusedMs: number;
  underruns: number;
  starvedMs: number;
  /** First counted frame to last, from health polls: the device's own spread. */
  spreadMs: number | null;
  delta: DeviceCensus;
  problems: string[];
}

/**
 * Drive the modelled board from a recorded trace.
 *
 * The clock is the arrivals' own. Every 20 ms of it, whatever had arrived by
 * then is written and the converter takes one frame — the same order a real
 * device sees, since delivery and playback are independent of each other.
 */
function replay(arrivals: readonly Arrival[]): {
  board: Board;
  drops: number;
  lasts: number;
} {
  const board = new Board();
  let drops = 0;
  let lasts = 0;
  if (arrivals.length === 0) return { board, drops, lasts };

  const startedAt = arrivals[0]!.at;
  /* Long enough to drain whatever the last arrival left in the ring, plus a
   * whole ring's worth of slack so a run that overfilled it is still measured
   * rather than cut short. */
  const endAt = arrivals[arrivals.length - 1]!.at + RING_BYTES / PCM_BYTES_PER_MS + 1_000;
  let next = 0;
  for (let now = startedAt; now <= endAt; now += 20) {
    while (next < arrivals.length && arrivals[next]!.at <= now) {
      const arrival = arrivals[next]!;
      next++;
      if (arrival.drop) {
        drops++;
        board.clear();
      }
      if (arrival.mulawBytes > 0) board.write(arrival.mulawBytes * 2);
      if (arrival.last) {
        lasts++;
        board.finish();
      }
    }
    board.tick();
    if (board.drained && lasts > 0 && next >= arrivals.length) break;
  }
  return { board, drops, lasts };
}

/**
 * Judge one turn's trace against what the mock was told to say.
 *
 * `expectedAnswerMs` is null against the REAL provider, which chooses its own
 * answer length: there is then no left-hand side for "did everything arrive?"
 * from this side, and the arithmetic falls back to the audio that did arrive.
 * The claim that survives — and it is the one that has failed every previous
 * attempt at a count to one hundred — is that handing it over took as long as
 * saying it.
 */
function judge(
  turn: number,
  arrivals: readonly Arrival[],
  pressedAt: number,
  expectedAnswerMs: number | null,
  device?: { delta: DeviceCensus; samples: readonly DeviceSample[] },
): TurnVerdict {
  const { board, drops, lasts } = replay(arrivals);
  const mulawBytes = arrivals.reduce((total, arrival) => total + arrival.mulawBytes, 0);
  const receivedMs = mulawBytes / MULAW_BYTES_PER_MS;
  const answerMs = expectedAnswerMs ?? receivedMs;
  const first = arrivals[0];
  const lastArrival = arrivals[arrivals.length - 1];
  const spreadMs = first === undefined ? 0 : lastArrival!.at - first.at;
  const conversations = [...new Set(arrivals.map((arrival) => arrival.conversationId))];

  const problems: string[] = [];
  /* EVERY WORD. Padding rounds the tail up to a whole frame and nothing else
   * is added, so the device is handed the answer and at most 20 ms more. */
  if (expectedAnswerMs !== null && receivedMs < answerMs) {
    problems.push(
      `lost ${(answerMs - receivedMs).toFixed(0)}ms of speech: ` +
        `${receivedMs.toFixed(0)}ms of ${String(answerMs)}ms arrived`,
    );
  }
  if (expectedAnswerMs !== null && receivedMs >= answerMs + DEFAULT_SPEAKER_LIMITS.frameMs * 2) {
    problems.push(
      `${(receivedMs - answerMs).toFixed(0)}ms MORE than the answer arrived — ` +
        `padding is one frame, so this is a duplicate`,
    );
  }
  /* NOT ONE BYTE REFUSED. Invisible in a recording: a frame refused on
   * arrival was never a frame that went missing. */
  if (board.refusedBytes > 0) {
    problems.push(`${String(board.refusedBytes / PCM_BYTES_PER_MS)}ms refused at the board's door`);
  }
  /*
   * AND NO GAPS. An underrun after playback began is silence a listener heard
   * in the middle of a sentence.
   *
   * THE MODEL HAS NO PREFILL AND THE HARDWARE DOES. A real board waits for
   * 150 ms before its converter takes anything, which absorbs the ragged
   * first few hundred milliseconds of an answer the provider is still
   * generating; this model starts on the first byte. On answers of a couple
   * of seconds that difference is the whole measurement — measured on the
   * Waveshare, 3 and 16 dry drains here against 1 soft refill and 0 starved
   * milliseconds on the board itself. With `--board`, believe the board.
   */
  if (board.underruns > 0) {
    problems.push(
      `${String(board.underruns)} drains found the ring dry (${String(board.underruns * 20)}ms of gaps)`,
    );
  }
  /*
   * THE SPED-UP ANSWER, AS ARITHMETIC, and the single most important line in
   * this file. The server releases up to `leadMs` ahead of the listener, so
   * handing over an answer takes its own length minus that lead. Anything
   * dramatically shorter is the provider's burst reaching the device intact.
   */
  const floorMs = answerMs - DEFAULT_SPEAKER_LIMITS.leadMs - 2_000;
  if (spreadMs < floorMs) {
    problems.push(
      `handed over in ${(spreadMs / 1000).toFixed(1)}s what takes ` +
        `${(answerMs / 1000).toFixed(1)}s to say — THE ANSWER WAS DUMPED, not paced`,
    );
  }
  /* A real provider pauses mid-answer and the lane cannot make that up, so the
   * window is wider when nobody told it what to say. */
  if (spreadMs > answerMs + (expectedAnswerMs === null ? 30_000 : 10_000)) {
    problems.push(
      `took ${(spreadMs / 1000).toFixed(1)}s to hand over ${(answerMs / 1000).toFixed(1)}s ` +
        `of speech — the lane is behind the listener`,
    );
  }
  /*
   * THE CONTRACT WITH THE FIRMWARE. `leadMs` is what the ring must exceed;
   * raising it on the server without raising it on the board is how a device
   * starts refusing audio at the door on hardware this run never touched.
   */
  const peakMs = board.peakBuffered / PCM_BYTES_PER_MS;
  if (peakMs > DEFAULT_SPEAKER_LIMITS.leadMs + 1_500) {
    problems.push(
      `asked the board to hold ${peakMs.toFixed(0)}ms, over the ` +
        `${String(DEFAULT_SPEAKER_LIMITS.leadMs)}ms lead the ring is sized for`,
    );
  }
  /*
   * The old lane cut this into 20 ms frames: fifty events a second, each a
   * JSON parse and a dispatch on a microcontroller whose transport sustains a
   * few dozen messages a second in total.
   */
  const budget = Math.ceil((answerMs / DEFAULT_SPEAKER_LIMITS.maxChunkMs) * 1.5) + 20;
  if (arrivals.length > budget) {
    problems.push(
      `${String(arrivals.length)} events for ${(answerMs / 1000).toFixed(1)}s of speech ` +
        `(budget ${String(budget)}) — the device cannot parse that many`,
    );
  }
  /*
   * AND THE DROP MUST BE THE ANSWER'S FIRST WORD, not its fourth.
   *
   * `drop` tells the device to empty its ring, so audio released ahead of it
   * is audio the device is told to throw away the moment the instruction
   * catches up — the opening of every answer, silently. Invisible in every
   * total: the bytes were all sent, all received, and all counted.
   */
  const dropIndex = arrivals.findIndex((arrival) => arrival.drop);
  if (dropIndex > 0) {
    const aheadMs =
      arrivals.slice(0, dropIndex).reduce((total, arrival) => total + arrival.mulawBytes, 0) /
      MULAW_BYTES_PER_MS;
    problems.push(
      `the clear arrived ${String(dropIndex)} chunks late, behind ${String(aheadMs)}ms ` +
        `of the answer it clears`,
    );
  }
  if (drops !== 1) problems.push(`expected exactly one drop, saw ${String(drops)}`);
  if (lasts !== 1) problems.push(`expected exactly one last, saw ${String(lasts)}`);
  if (conversations.length > 1) {
    problems.push(`frames from ${String(conversations.length)} calls in one turn`);
  }

  const verdict: TurnVerdict = {
    turn,
    events: arrivals.length,
    receivedMs,
    spreadMs,
    firstFrameMs: first === undefined ? null : first.at - pressedAt,
    refusedBytes: board.refusedBytes,
    underruns: board.underruns,
    peakBufferedMs: board.peakBuffered / PCM_BYTES_PER_MS,
    drops,
    lasts,
    conversations,
    problems,
  };
  if (device !== undefined) {
    verdict.device = judgeDevice(device.delta, device.samples, receivedMs, answerMs);
    for (const problem of verdict.device.problems) problems.push(`the board says: ${problem}`);
  }
  return verdict;
}

/**
 * THE SAME FOUR QUESTIONS, PUT TO THE HARDWARE.
 *
 * `laneMs` is what this process watched go past on the stream; the board's own
 * `spkFrames` is what reached the other end of the device's socket, got out of
 * its inbox, decoded, and was handed to its ring. Everything between those two
 * numbers is invisible from here and has broken before.
 */
function judgeDevice(
  delta: DeviceCensus,
  samples: readonly DeviceSample[],
  laneMs: number,
  answerMs: number,
): DeviceVerdict {
  const problems: string[] = [];
  /*
   * A COUNTER THAT WENT BACKWARDS MEANS THE BOARD RESTARTED, and every number
   * below it is then arithmetic on two different lives. Say so instead:
   * measured on the StackChan mid-conversation, "-160.98s received", which is
   * a reboot wearing a measurement's clothes. `resetReason` and `restartNote`
   * on its health say which restart it was.
   */
  if (delta.spkFrames < 0 || delta.spkPlayed < 0) {
    return {
      receivedMs: 0,
      playedMs: 0,
      refusedMs: 0,
      underruns: 0,
      starvedMs: 0,
      spreadMs: null,
      delta,
      problems: ["THE BOARD RESTARTED during this turn — its counters went backwards"],
    };
  }
  const receivedMs = delta.spkFrames * DEFAULT_SPEAKER_LIMITS.frameMs;
  const playedMs = delta.spkPlayed * DEFAULT_SPEAKER_LIMITS.frameMs;
  const refusedMs = delta.spkOverflow * DEFAULT_SPEAKER_LIMITS.frameMs;

  /* EVERYTHING SENT WAS RECEIVED, with the device as the witness. One frame of
   * slack: a poll can land between the socket and the counter. */
  if (receivedMs + DEFAULT_SPEAKER_LIMITS.frameMs < laneMs) {
    problems.push(
      `the lane carried ${(laneMs / 1000).toFixed(2)}s and the board counted ` +
        `${(receivedMs / 1000).toFixed(2)}s — ${((laneMs - receivedMs) / 1000).toFixed(2)}s ` +
        `never reached it`,
    );
  }
  /* NOTHING REFUSED AT THE DOOR. */
  if (delta.spkOverflow > 0) {
    problems.push(
      `${String(refusedMs)}ms refused at the door (spkOverflow ${String(delta.spkOverflow)})`,
    );
  }
  /* NO GAPS. Two instruments: the promoted underrun and the ms the firmware
   * itself calls the audible-failure gate. */
  if (delta.spkSoftDryRefills > 0) {
    problems.push(`${String(delta.spkSoftDryRefills)} underruns (spkSoftDryRefills)`);
  }
  if (delta.spkStarvedMs > 0) {
    problems.push(`${String(delta.spkStarvedMs)}ms starved`);
  }
  /* AND EVERY OTHER WAY AUDIO CAN VANISH WITHOUT TOUCHING THOSE. */
  for (const name of [
    "spkDecodeFailures",
    "spkBadFrames",
    "spkWriteFailures",
    "spkDiscarded",
    "spkSupersededMidplay",
  ] as const) {
    if (delta[name] > 0) problems.push(`${name} +${String(delta[name])}`);
  }
  /*
   * RECEIVED IS NOT PLAYED, and every frame has to be somewhere.
   *
   * A ring that took every frame and a converter that never drained it is a
   * board holding the answer, not speaking it — and it reads identically to a
   * perfect run on `spkFrames` alone. The identity below closes the books:
   * a received frame is played, skipped to catch up, discarded, or refused,
   * and anything left over is audio nobody can account for.
   */
  const accountedFor =
    delta.spkPlayed +
    delta.spkCatchup +
    delta.spkDiscarded +
    delta.spkWriteFailures +
    delta.spkBadFrames;
  if (accountedFor + 5 < delta.spkFrames) {
    problems.push(
      `${String(delta.spkFrames - accountedFor)} frames received and never accounted for ` +
        `(played ${String(delta.spkPlayed)}, skipped ${String(delta.spkCatchup)}, ` +
        `discarded ${String(delta.spkDiscarded)})`,
    );
  }
  if (delta.spkCatchup > 0) {
    problems.push(
      `${String(delta.spkCatchup * DEFAULT_SPEAKER_LIMITS.frameMs)}ms skipped to catch up ` +
        `(spkCatchup +${String(delta.spkCatchup)})`,
    );
  }

  /*
   * NO SPEED-UP, MEASURED ON THE BOARD'S OWN COUNTER. The health polls give
   * `spkFrames` against wall clock, so the first poll that moved it to the last
   * poll that moved it IS the device's own spread — no trace from this process
   * in it at all. Polling granularity bounds the precision, which is why the
   * floor below is the same generous one the lane is held to.
   */
  const moved = samples.filter(
    (sample, index) => index === 0 || sample.frames > samples[index - 1]!.frames,
  );
  const firstMoved = moved.length > 1 ? moved[1] : undefined;
  const lastMoved = moved.length > 1 ? moved[moved.length - 1] : undefined;
  const spreadMs =
    firstMoved === undefined || lastMoved === undefined ? null : lastMoved.at - firstMoved.at;
  if (spreadMs !== null && receivedMs > 10_000) {
    const floorMs = answerMs - DEFAULT_SPEAKER_LIMITS.leadMs - 4_000;
    if (spreadMs < floorMs) {
      problems.push(
        `the board took ${(spreadMs / 1000).toFixed(1)}s to receive ` +
          `${(receivedMs / 1000).toFixed(1)}s of speech — THE ANSWER WAS DUMPED at the device`,
      );
    }
  }

  return {
    receivedMs,
    playedMs,
    refusedMs,
    underruns: delta.spkSoftDryRefills,
    starvedMs: delta.spkStarvedMs,
    spreadMs,
    delta,
    problems,
  };
}

/** The subset of the guest worker's RPC surface this driver calls. */
interface VoiceAgentSetup {
  health(): Promise<{ ok: true; projectId: string; xaiSecretReady: boolean }>;
  setupVoiceAgent(options: {
    streamPath: string;
    providerBaseUrl?: string;
  }): Promise<{ streamPath: string; warm: { ok: boolean; ms: number } }>;
}

/** A cold dynamic-worker build is the slowest thing here, and a compile error
 * in the committed file surfaces only as a failing health call. */
const HEALTH_TIMEOUT_MS = 30_000;

async function waitForVoiceAgent(
  voiceAgent: DynamicWorkerCapability<VoiceAgentSetup>,
): Promise<{ projectId: string; xaiSecretReady: boolean }> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: unknown;
  for (;;) {
    try {
      return await withRpcResult(voiceAgent.health(), ({ projectId, xaiSecretReady }) => ({
        projectId,
        xaiSecretReady,
      }));
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await sleep(1_000);
    }
  }
  throw new Error(
    `voice-agent did not become healthy within ${String(HEALTH_TIMEOUT_MS / 1000)}s. ` +
      `This is usually a compile error in the committed voice-agent.ts:\n${String(lastError)}`,
  );
}

export async function paced(options: PacedOptions) {
  const answerSeconds = options.answerSeconds ?? 90;
  const answerMs = Math.round(answerSeconds * 1000);
  const turns = Math.max(1, options.turns ?? 1);
  const gapMs = options.gapMs ?? 2_000;
  const settleMs = options.settleMs ?? Math.round(answerMs * 1.5) + 30_000;
  const pressMs = options.pressMs ?? 1_500;
  /** What to speak out loud, one per turn, cycled. Empty is a silent press. */
  const prompts = (options.say ?? "")
    .split("|")
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  /*
   * THE REAL PROVIDER CHOOSES ITS OWN ANSWER LENGTH, so there is no left-hand
   * side and `answerSeconds` becomes a wait rather than an expectation. Every
   * assertion that needs one is skipped by passing null into `judge`; the ones
   * that survive are the ones a listener makes.
   */
  const real = options.real === true;

  const fake = real
    ? null
    : await startFakeGrok({
        ...(options.tunnelName === undefined ? {} : { name: options.tunnelName }),
        ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
      });
  /*
   * `burst=1` so the provider hands the whole answer over as fast as the wire
   * allows — which is what a real one does and what the server has to absorb.
   * `base64Audio=1` because the facet ignores binary provider frames outright,
   * so a mock sending them is a silent call.
   */
  const providerBaseUrl =
    fake === null
      ? undefined
      : `${fake.url}/v1/realtime` +
        `?answerSeconds=${String(answerSeconds)}&burst=1&base64Audio=1&answerDelayMs=150`;

  const arrivals: Arrival[] = [];
  const lifecycle: { type: string; at: number; detail: string }[] = [];
  /** What the provider said it was saying, when there is a transcript to read. */
  let transcript = "";
  /** What the provider says it HEARD, which is the prompt's own receipt. */
  let heard = "";
  let lastSpkAt = 0;

  try {
    using itx = await connectProject(options);

    /*
     * THE BOARD IS THE CLIENT, AND IT CHOOSES THE STREAM. A device listens on
     * one path — the one its provisioning gave it — so a press anywhere else
     * is a proof about a stream nobody is holding a microphone to. Asking the
     * board itself also proves, before anything else happens, that it is alive
     * NOW: `connected` in the presence catalog has been observed two days stale.
     */
    const board =
      options.board === undefined ? null : deviceCapability<BoardCapability>(itx, options.board);
    let boardHealthNow: Record<string, unknown> | null = null;
    if (board !== null) {
      boardHealthNow = await boardHealth(board);
      console.log(
        `board ${String(options.board)}: transport=${String(boardHealthNow.transport)} ` +
          `voicelab=${String(boardHealthNow.voicelab)} gateOpen=${String(boardHealthNow.gateOpen)} ` +
          `up ${((Number(boardHealthNow.uptimeMs) || 0) / 1000).toFixed(0)}s`,
      );
      if (boardHealthNow.gateOpen !== true) {
        throw new Error(
          `the board's producer gate is shut (voicelab=${String(boardHealthNow.voicelab)}, ` +
            `transport=${String(boardHealthNow.transport)}) — it will answer RPCs and nothing else`,
        );
      }
    }
    const streamPath =
      options.streamPath ??
      (boardHealthNow === null
        ? `/agents/voice/paced-${Date.now().toString(36)}`
        : String(boardHealthNow.conversation));
    console.log(`paced proof on ${streamPath}`);
    console.log(`  provider  ${providerBaseUrl ?? "x.ai (the real one)"}`);
    console.log(
      `  asking for ${String(turns)} turn(s)` +
        (real ? "" : ` of ${answerSeconds.toFixed(1)}s`) +
        `\n`,
    );

    const install = await installVoiceAgent(itx);
    console.log(
      `  ${install.changed ? "installed" : "already current"} ` +
        `(${install.commitOid.slice(0, 8)}): ${install.paths.join(", ")}`,
    );

    using voiceAgent = itx.workers.get(
      voiceAgentEntrypointRef,
    ) as unknown as DynamicWorkerCapability<VoiceAgentSetup>;
    const health = await waitForVoiceAgent(voiceAgent);
    console.log(`  voice-agent healthy for ${health.projectId}`);

    const setup = await withRpcResult(
      voiceAgent.setupVoiceAgent({
        ...(providerBaseUrl === undefined ? {} : { providerBaseUrl }),
        streamPath,
      }),
      ({ warm }) => ({ warm: { ok: warm.ok, ms: warm.ms } }),
    );
    console.log(`  setup done, processor acknowledged in ${String(setup.warm.ms)}ms\n`);

    const stream = itx.streams.get(streamPath);
    const connection = await stream.openConnection({
      connectionKey: `paced-${Date.now().toString(36)}`,
      eventTypes: [
        SPK_FRAME,
        "events.iterate.com/voice-agent/grok-event",
        "events.iterate.com/voice-agent/call-started",
        "events.iterate.com/voice-agent/conversation-accepted",
        "events.iterate.com/voice-agent/conversation-ended",
        "events.iterate.com/voice-agent/conversation-failed",
        "events.iterate.com/voice-agent/provider-error",
      ],
      processEventBatch: (batch: { events?: { type: string; payload?: unknown }[] }) => {
        const at = Date.now();
        for (const event of batch.events ?? []) {
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          if (event.type === SPK_FRAME) {
            lastSpkAt = at;
            arrivals.push({
              at,
              conversationId: String(payload.conversationId ?? ""),
              drop: payload.drop === true,
              last: payload.last === true,
              mulawBytes: Buffer.from(String(payload.pcm ?? ""), "base64").length,
            });
            continue;
          }
          /*
           * WHAT IT SAID, which no counter can give and which is the whole
           * point of asking a real provider to count to one hundred: ninety
           * seconds of audio that stops at "sixty-three" is every counter here
           * reading perfect.
           */
          if (event.type === "events.iterate.com/voice-agent/grok-event") {
            const inner = (
              payload as {
                event?: { type?: string; delta?: string; transcript?: string };
              }
            ).event;
            if (inner?.type === "response.output_audio_transcript.delta") {
              transcript += inner.delta ?? "";
            }
            /*
             * AND WHAT IT HEARD, which is the other half of a spoken prompt.
             * A board that mishears "count to one hundred" as "help me with
             * my code" produces a perfect answer to a question nobody asked,
             * and without this the only symptom is a transcript that does not
             * contain the word being looked for.
             */
            if (inner?.type?.includes("input_audio_transcription")) {
              heard += inner.transcript ?? inner.delta ?? "";
            }
            continue;
          }
          lifecycle.push({
            at,
            detail: String(payload.reason ?? payload.message ?? payload.conversationId ?? ""),
            type: event.type.replace("events.iterate.com/voice-agent/", ""),
          });
        }
      },
    });

    try {
      /*
       * THE PRESS IS EPHEMERAL AND AN EVICTED STREAM CANNOT HEAR IT. Setup's
       * own handshake already woke this facet, but the build and the connect
       * above take seconds; one more token costs a round trip and removes the
       * only way this run can prove nothing at all.
       */
      const token = crypto.randomUUID();
      const committed = await stream.append({ payload: { token }, type: WARMUP });
      await stream.waitForEvent({
        afterOffset: (committed.at(0)?.offset ?? 1) - 1,
        eventTypes: [
          "events.iterate.com/voice-agent/warmup-ready",
          "events.iterate.com/voice-agent/warmup-unresolved",
        ],
        timeoutMs: 90_000,
      });

      /*
       * OPEN THE CALL FIRST, AND WAIT FOR IT TO BE LIVE.
       *
       * A press is not a turn on this hardware. `voice_loop.c` opens a turn
       * only `if (wants_talk && !talking && call_active)`, and `wants_talk` is
       * a LEVEL — so a button held for 700 ms while the dial is still in
       * flight is released before the call goes active, the condition is never
       * true with the button down, and the board captures nothing, sends
       * nothing and commits nothing. Measured on the Waveshare: `framesSent`
       * 0, the provider saw `[session.update]` and no commit, and the call
       * then aged out on the idle deadline sixty seconds later.
       */
      let pressesItsOwnButton = false;
      if (board !== null) {
        const openedAt = Date.now();
        /*
         * TWO OF THESE BOARDS HAVE NO BUTTON, and it is not a bug: the module
         * is mounted only where the microphone is not open for the whole call
         * ("offering it anyway gives an agent a method that would silently
         * mute live audio" — `voice_loop.c`). So the surface is PROBED rather
         * than looked up in a table here, and an open-mic board's turn is
         * bounded from the stream instead: the facet acts on `ptt-end` from
         * whoever appends it, and with a mock there is no server VAD to end
         * a turn any other way. The board is still the listener throughout,
         * which is what this proof is about.
         */
        pressesItsOwnButton = await board.pushToTalk
          .start()
          .then(() => true)
          .catch(() => false);
        if (pressesItsOwnButton) await board.pushToTalk.stop();
        else await board.conversation.start();
        console.log(
          `  the board ${pressesItsOwnButton ? "has a talk button" : "is open-mic; the turn is bounded from the stream"}`,
        );
        let liveMs: number | null = null;
        while (Date.now() - openedAt < 90_000) {
          if ((await boardHealth(board)).callActive === true) {
            liveMs = Date.now() - openedAt;
            break;
          }
          await sleep(500);
        }
        if (liveMs === null) throw new Error("the board's call never went active");
        console.log(`  the board's call went live in ${String(liveMs)}ms`);
        /*
         * AND LET IT FINISH SAYING HELLO.
         *
         * A real call opens with a greeting the model was asked for, and it is
         * an ANSWER like any other: pressing through it commits a turn while a
         * response is already in flight, and the settle loop below then takes
         * the greeting's own `last` as the end of the turn it never heard.
         * Measured on the Waveshare asking for a count to one hundred: 7.92 s
         * of "Hello there, I'm Eve", every counter perfect, and the actual
         * question unanswered. Quiet on the speaker lane is the signal, as
         * everywhere else here.
         */
        const greetingBy = Date.now() + 45_000;
        lastSpkAt = 0;
        while (Date.now() < greetingBy) {
          await sleep(500);
          if (lastSpkAt === 0) {
            if (arrivals.length === 0 && Date.now() - openedAt > 12_000) break;
            continue;
          }
          if (Date.now() - lastSpkAt > 3_000) break;
        }
        if (arrivals.length > 0) {
          console.log(
            `  it greeted first (${String(arrivals.length)} chunks); the turns below start from silence`,
          );
          arrivals.length = 0;
          transcript = "";
          heard = "";
        }
        console.log("");
      }

      const verdicts: TurnVerdict[] = [];
      for (let turn = 1; turn <= turns; turn++) {
        const before = arrivals.length;
        const transcriptBefore = transcript.length;
        const heardBefore = heard.length;
        const censusBefore = board === null ? null : census(await boardHealth(board));
        const samples: DeviceSample[] = [];
        const pressedAt = Date.now();
        const prompt = prompts.length === 0 ? null : prompts[(turn - 1) % prompts.length]!;
        /*
         * AN OPEN-MIC BOARD ON THE REAL PROVIDER SEGMENTS ITSELF.
         *
         * Its session carries `turn_detection: server_vad`, so the provider
         * decides when the utterance ended. Appending `ptt-end` on top sends a
         * second `input_audio_buffer.commit` and `response.create` into a
         * session that is already answering — two responses to one sentence,
         * and the facet would mark the first one's chunk `last` in the middle
         * of the other. So say the words and let the provider hear the silence.
         */
        const segmentsItself = real && !pressesItsOwnButton;
        if (segmentsItself) {
          if (prompt === null) await sleep(pressMs);
          else {
            console.log(`    saying out loud: ${JSON.stringify(prompt)}`);
            await run("say", ["-r", "170", prompt]);
          }
        } else if (!pressesItsOwnButton && prompt === null) {
          /* One append, so the release cannot overtake the press it belongs to.
           * Both ephemeral: this is a button, not a record. */
          await discardRpcResult(
            stream.append(
              { ephemeral: true, payload: { t: pressedAt }, type: PTT_START },
              { ephemeral: true, payload: { t: pressedAt }, type: PTT_END },
            ),
          );
        } else {
          /*
           * THE BOARD'S OWN BUTTON where it has one: `pushToTalk.start()`
           * opens the call as well as the microphone, and the press travels
           * the device's own uplink, which an append from here would skip.
           */
          const openTurn = async () => {
            if (pressesItsOwnButton) await board!.pushToTalk.start();
            else {
              await discardRpcResult(
                stream.append({
                  ephemeral: true,
                  payload: { t: Date.now() },
                  type: PTT_START,
                }),
              );
            }
          };
          const closeTurn = async () => {
            if (pressesItsOwnButton) await board!.pushToTalk.stop();
            else {
              await discardRpcResult(
                stream.append({ ephemeral: true, payload: { t: Date.now() }, type: PTT_END }),
              );
            }
          };
          await openTurn();
          if (prompt === null) await sleep(pressMs);
          else {
            /* OUT OF THE MAC'S SPEAKER AND INTO THE BOARD'S MICROPHONE.
             * Nothing is injected past the hardware, because the hardware is
             * what keeps breaking. */
            console.log(`    saying out loud: ${JSON.stringify(prompt)}`);
            await run("say", ["-r", "170", prompt]);
            /* The capture queue holds the tail; let it fill before releasing. */
            await sleep(600);
          }
          await closeTurn();
        }

        /* Quiet on the speaker lane is the signal, not a fixed wait: the
         * answer is paced, so "nothing for five seconds" means it is over. */
        const deadline = Date.now() + settleMs;
        lastSpkAt = 0;
        let nextPoll = 0;
        while (Date.now() < deadline) {
          await sleep(250);
          /*
           * THE DEVICE'S OWN ARRIVAL CURVE. `spkFrames` against wall clock is
           * a spread measured with nothing of this laptop's in it: if the
           * server dumped ninety seconds in five, this counter jumps by 4500
           * between two polls and says so on its own.
           */
          if (board !== null && Date.now() >= nextPoll) {
            nextPoll = Date.now() + 2_500;
            const now = await boardHealth(board).catch(() => null);
            if (now !== null) {
              samples.push({
                at: Date.now(),
                frames: Number(now.spkFrames ?? 0),
                played: Number(now.spkPlayed ?? 0),
                discarded: Number(now.spkDiscarded ?? 0),
                answerStarts: Number(now.spkAnswerStarts ?? 0),
              });
            }
          }
          const done = arrivals.slice(before).some((arrival) => arrival.last);
          if (done) break;
          if (lastSpkAt !== 0 && Date.now() - lastSpkAt > 5_000) break;
        }
        /*
         * THE `last` CHUNK IS THE END OF DELIVERY, NOT THE END OF PLAYBACK.
         *
         * Up to `leadMs` of the answer is still in the board's ring when the
         * stream goes quiet, and it plays out at exactly one frame per 20 ms
         * however impatient this process is. Reading the census then reports
         * frames received and never played — a real failure, manufactured. A
         * fixed sleep is the wrong instrument for the same reason the settle
         * loop is not one: wait for the FACT, which is `spkPlayed` standing
         * still with nothing left owed.
         */
        if (board !== null) {
          const drainBy = Date.now() + DEFAULT_SPEAKER_LIMITS.leadMs + 15_000;
          let stable = 0;
          let previous = -1;
          while (Date.now() < drainBy) {
            await sleep(1_000);
            const now = census(await boardHealth(board));
            const played = now.spkPlayed + now.spkDiscarded;
            stable = played === previous ? stable + 1 : 0;
            previous = played;
            if (stable >= 2 && now.spkFrames <= played) break;
          }
        }

        const censusAfter = board === null ? null : census(await boardHealth(board));
        if (board !== null && censusAfter !== null) {
          samples.push({
            at: Date.now(),
            frames: censusAfter.spkFrames,
            played: censusAfter.spkPlayed,
            discarded: censusAfter.spkDiscarded,
            answerStarts: censusAfter.spkAnswerStarts,
          });
        }
        const verdict = judge(
          turn,
          arrivals.slice(before),
          pressedAt,
          real ? null : answerMs,
          censusBefore === null || censusAfter === null
            ? undefined
            : { delta: censusDelta(censusBefore, censusAfter), samples },
        );
        verdicts.push(verdict);
        console.log(
          `  turn ${String(turn)}: ${String(verdict.events)} events, ` +
            `${(verdict.receivedMs / 1000).toFixed(2)}s of audio, ` +
            `spread ${(verdict.spreadMs / 1000).toFixed(1)}s, ` +
            `first frame +${verdict.firstFrameMs === null ? "never" : `${String(verdict.firstFrameMs)}ms`}, ` +
            `peak ${verdict.peakBufferedMs.toFixed(0)}ms held, ` +
            `${String(verdict.refusedBytes)}B refused, ` +
            `${String(verdict.underruns)} underruns`,
        );
        if (verdict.device !== undefined) {
          const device = verdict.device;
          console.log(
            `    the board: ${(device.receivedMs / 1000).toFixed(2)}s received, ` +
              `${(device.playedMs / 1000).toFixed(2)}s played, ` +
              `${String(device.refusedMs)}ms refused, ` +
              `${String(device.underruns)} underruns, ` +
              `${String(device.starvedMs)}ms starved, ` +
              `spread ${device.spreadMs === null ? "n/a" : `${(device.spreadMs / 1000).toFixed(1)}s`}, ` +
              `mic ${String(device.delta.framesSent)} frames out`,
          );
          /* WHEN, not just how much. A discard is a moment, and which moment
           * it was is the whole diagnosis — an answer thrown away at the press
           * is the device doing its job, and one thrown away mid-answer is a
           * listener losing a sentence. */
          console.log(
            `    the board, over time: ` +
              samples
                .map(
                  (sample) =>
                    `+${((sample.at - pressedAt) / 1000).toFixed(0)}s ` +
                    `f${String(sample.frames)}/p${String(sample.played)}` +
                    `/d${String(sample.discarded)}/a${String(sample.answerStarts)}`,
                )
                .join("  "),
          );
        }
        if (heard.length > heardBefore) {
          console.log(`    it heard: ${JSON.stringify(heard.slice(heardBefore).trim())}`);
        }
        if (transcript.length > transcriptBefore) {
          console.log(
            `    it said: ${JSON.stringify(transcript.slice(transcriptBefore, transcriptBefore + 400))}`,
          );
        }
        if (verdict.problems.length > 0) {
          console.log(`    ← ${verdict.problems.join("; ")}`);
        }
        if (turn < turns) await sleep(gapMs);
      }

      /*
       * ONE CALL is the negative proof, and it only means something with more
       * than one turn: a conversation held across several presses must not
       * have re-dialled between them.
       */
      const callsStarted = lifecycle.filter((event) => event.type === "call-started").length;
      const faults = lifecycle.filter(
        (event) => event.type === "conversation-failed" || event.type === "provider-error",
      );
      const problems = verdicts.flatMap((verdict) =>
        verdict.problems.map((problem) => `turn ${String(verdict.turn)}: ${problem}`),
      );
      /*
       * ZERO IS ALSO ONE CALL, and only on a board. A device holds its call
       * across runs — it is the same conversation to the person in the room —
       * so a run that presses four times into a call that was already up
       * appends no `call-started` at all. That is the claim being made, not a
       * missing event. Two is the failure: a conversation that re-dialled.
       */
      if (callsStarted > 1 || (board === null && callsStarted !== 1)) {
        problems.push(
          `expected ONE call across ${String(turns)} turn(s), saw ${String(callsStarted)}`,
        );
      }
      for (const fault of faults) problems.push(`${fault.type}: ${fault.detail.slice(0, 200)}`);
      /* WHAT IT SAID, because every counter here is blind to an answer that
       * was cut off: the bytes that did arrive all arrived perfectly. */
      if (
        options.expect !== undefined &&
        !transcript.toLowerCase().includes(options.expect.toLowerCase())
      ) {
        problems.push(
          `the answer never reached "${options.expect}" — it ended on ` +
            JSON.stringify(transcript.slice(-120)),
        );
      }

      /*
       * The provider's own record of what it sent is the only honest left-hand
       * side of "did everything arrive?". Comparing against `answerSeconds`
       * would call a mock that shipped nothing a pass the day it stopped
       * shipping.
       */
      const spokenMs =
        fake === null
          ? null
          : fake.sessions.reduce(
              (total, session) => total + session.speakerBytes / PCM_BYTES_PER_MS,
              0,
            );
      const heardMs = verdicts.reduce((total, verdict) => total + verdict.receivedMs, 0);
      if (spokenMs !== null && heardMs + DEFAULT_SPEAKER_LIMITS.frameMs * turns < spokenMs) {
        problems.push(
          `the provider sent ${(spokenMs / 1000).toFixed(2)}s and the device was handed ` +
            `${(heardMs / 1000).toFixed(2)}s`,
        );
      }

      console.log("\n  the stream, in its own words:");
      for (const event of lifecycle) {
        console.log(`    ${event.type}${event.detail === "" ? "" : `  — ${event.detail}`}`);
      }
      /*
       * THE PROVIDER'S OWN WORDS, per session, because "how many sockets did
       * the facet open?" is a question only this side can answer — and a dial
       * that opened a socket and never used it is invisible from the stream.
       */
      if (fake !== null) {
        console.log(`\n  the provider, in its own words:`);
        for (const session of fake.sessions) {
          console.log(
            `    session ${String(session.id)}: ${String(session.commits)} commit(s), ` +
              `${String(session.answers)} answer(s), ` +
              `${(session.speakerBytes / PCM_BYTES_PER_MS / 1000).toFixed(2)}s spoken, ` +
              `saw [${session.received.join(", ")}], ` +
              `${session.closedAt === null ? "still open" : `closed by ${String(session.closedBy)}`}`,
          );
        }
      }

      const report = {
        ok: problems.length === 0,
        board: options.board ?? null,
        streamPath,
        providerBaseUrl: providerBaseUrl ?? "https://api.x.ai",
        answerSeconds: real ? null : answerSeconds,
        turns,
        callsStarted,
        providerSessions: fake === null ? null : fake.sessions.length,
        spokenSeconds: spokenMs === null ? null : Number((spokenMs / 1000).toFixed(3)),
        heardSeconds: Number((heardMs / 1000).toFixed(3)),
        transcript,
        heard,
        perTurn: verdicts.map((verdict) => ({
          turn: verdict.turn,
          events: verdict.events,
          receivedMs: Math.round(verdict.receivedMs),
          spreadMs: verdict.spreadMs,
          firstFrameMs: verdict.firstFrameMs,
          refusedBytes: verdict.refusedBytes,
          underruns: verdict.underruns,
          peakBufferedMs: Math.round(verdict.peakBufferedMs),
          drops: verdict.drops,
          lasts: verdict.lasts,
          conversations: verdict.conversations,
          device:
            verdict.device === undefined
              ? null
              : {
                  receivedMs: verdict.device.receivedMs,
                  playedMs: verdict.device.playedMs,
                  refusedMs: verdict.device.refusedMs,
                  underruns: verdict.device.underruns,
                  starvedMs: verdict.device.starvedMs,
                  spreadMs: verdict.device.spreadMs,
                  delta: verdict.device.delta,
                },
        })),
        problems,
      };
      console.log(`\n${JSON.stringify(report, null, 2)}`);
      if (!report.ok) process.exitCode = 1;
    } finally {
      closeAndDisposeRpcHandle(connection);
      /* Leave the board idle rather than on a call this run opened: the next
       * one presses to open its own, and a call left up is 60 s of a deadline
       * ticking against a board nobody is talking to. */
      if (board !== null) await board.conversation.end().catch(() => undefined);
    }
  } finally {
    fake?.close();
  }
}
