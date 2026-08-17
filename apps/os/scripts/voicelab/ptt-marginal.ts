// MARGINAL overhead: how much longer does an answer take because our stream
// is in the middle?
//
// `ptt-latency` and `ptt-baseline` each answer half of this, in separate runs,
// minutes apart, against a provider whose own think time wanders by hundreds
// of milliseconds between rounds. Subtracting two such numbers measures the
// provider's mood as much as our plumbing. This runs BOTH halves in one
// process, alternating turn by turn, speaking the identical audio at identical
// pacing — so the difference between the two medians is ours and not the
// weather.
//
// BOTH HALVES HOLD ONE SOCKET FOR THE WHOLE RUN. The direct half dials xAI
// once; the v2 facet opens a call when somebody first talks and keeps it until
// a minute of silence ends it. So neither half pays a handshake per round, and
// the difference between the two medians is the plumbing between them.
//
//   doppler run --config preview_3 -- pnpm cli voicelab ptt-marginal \
//     --project voice-test --stream-path /agents/voice2/marginal-1 \
//     --mic-wav /tmp/utterance.wav --rounds 20
//
// Attribution, not just a total, and WITHOUT aligning two clocks. The facet
// emits one tiny `turn-timing` event per turn holding its own stamps, and the
// two provider terms in it — the round trip to xAI and the model's think time
// — are facet-clock DURATIONS. Subtracting them from a locally measured total
// leaves everything that is ours, with the skew cancelled out. That is both
// simpler and tighter than estimating an offset and splitting the answer into
// an uplink and a downlink either side of it.
//
// EVERY STAMP HERE NAMES ITS CLOCK, per the taxonomy in `voice-agent2.ts`:
// `...AtDeviceMs` is this process (it is the client — it holds the microphone),
// `...AtFacetMs` is the facet's. Nothing subtracts one from the other. This
// file used to call them `at` and `facetT`, which is how a probe ends up
// reporting a latency of minus fifty-nine seconds.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { closeAndDisposeRpcHandle, discardRpcResult } from "./rpc-ownership.ts";

/** Options for `pnpm cli voicelab ptt-marginal`. */
export interface PttMarginalOptions extends VoicelabConnectOptions {
  /** The stream whose facet is under test. Must already be set up. */
  streamPath?: string;
  /** How many A/B pairs to run. Medians of fewer than about six mean little. */
  rounds?: number;
  /**
   * A PCM16 mono 16 kHz WAV holding ONE utterance, a few seconds long.
   *
   * Required, and it must contain words: a tone gives the model nothing to
   * answer, and a turn the model declines to answer is not a latency.
   */
  micWav: string;
  /** Ceiling on the wait for an answer to finish before the next press. */
  settleMs?: number;
  /** Frames per append. Twelve is what the C client sends. */
  framesPerAppend?: number;
  /** Provider endpoint for the direct half. Defaults to xAI's realtime API. */
  grokBaseUrl?: string;
  model?: string;
  /**
   * Also measure the bare append round trip, before each press.
   *
   * OFF BY DEFAULT BECAUSE IT IS NOT FREE. The only event v2 consumes that
   * starts nothing is `warmup`, and `warmup` is DURABLE — so each probe is a
   * one-at-a-time delivery to the facet, which answers with a durable
   * `warmup-ready`, which is another. Six of those land immediately before the
   * button goes down, in front of the microphone frames, on the lane whose
   * stalling is the thing under investigation. A probe that can produce the
   * effect it is measuring has to be something you turn on deliberately.
   */
  appendProbe?: boolean;
  /**
   * Append a consumed no-op `keepalive` this often, so the delivery lanes
   * never go idle mid-run. 0 disables — which restores the per-turn idle
   * teardown and its resurrection costs, on purpose, for A/B runs.
   */
  keepWarmSeconds?: number;
}

const FRAME_MS = 20;
/** 20 ms of 16 kHz PCM16 = 320 samples = 640 bytes. */
const FRAME_SAMPLES = 320;
/** Round-trip probes per round; the median of three beats any one. */
const APPEND_PROBES = 3;
/** How long to wait for a turn's attribution after its audio has arrived. */
const TURN_REPORT_GRACE_MS = 750;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The frames of a PCM16 mono 16 kHz WAV, base64, 20 ms at a time. */
function framesFromWav(file: string): string[] {
  const bytes = fs.readFileSync(file);
  /* Find the data chunk rather than assuming a 44-byte header: a WAV written
   * by anything other than us may carry extra chunks. */
  const dataAt = bytes.indexOf("data", 12, "ascii");
  const start = dataAt === -1 ? 44 : dataAt + 8;
  const frames: string[] = [];
  for (
    let offset = start;
    offset + FRAME_SAMPLES * 2 <= bytes.length;
    offset += FRAME_SAMPLES * 2
  ) {
    frames.push(bytes.subarray(offset, offset + FRAME_SAMPLES * 2).toString("base64"));
  }
  return frames;
}

/** Median and tails. A mean hides exactly the round worth looking at. */
function summarize(values: number[]): { n: number; p50: number; p90: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1]! };
}

function median(values: number[]): number | null {
  const summary = summarize(values);
  return summary === null ? null : summary.p50;
}

/** Each value minus the set's minimum: lateness against the run's own floor. */
function latenesses(raw: (number | null)[]): ReturnType<typeof summarize> {
  const values = raw.filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  const floor = Math.min(...values);
  return summarize(values.map((value) => value - floor));
}

/** What one turn cost, however it was carried. */
interface Turn {
  /** Release -> first answer audio at this process. What a person feels. */
  totalMs: number | null;
  /**
   * Whether this round measured a healthy turn, and so counts in the medians.
   *
   * This used to be `warm`: true unless ANY call-lifecycle event arrived while
   * the turn was in flight. That briefly became wrong when the facet hung up
   * after every answer — a `call-started` per round was then the design, so
   * the rule discarded every round, emptied every median, and made a run of
   * eight perfect turns report no measurement and exit non-zero.
   *
   * A conversation is one call again, so a mid-run `call-started` really does
   * mean something was re-dialled. It is still not what makes a round DIRTY:
   * the count is reported on its own (`callsStarted` below — one for a whole
   * run is the healthy shape), and a round is dirty only when the stream says
   * something went wrong, `conversation-failed` or `provider-error`.
   */
  clean: boolean;
}

/** A stream turn, with the facet's own clock folded in. */
interface StreamTurn extends Turn {
  /**
   * Everything that is OURS, with the clocks cancelled out.
   *
   * `totalMs` is measured here and the provider's two terms are facet-clock
   * durations, so the remainder is the append reaching the facet, the facet's
   * own work, and the answer's first frame reaching this process — with no
   * clock alignment and therefore no error bars from one.
   */
  ourMs: number | null;
  /** Round-trip to the Durable Object alone, with no delivery lane in it. */
  appendRttMs: number | null;
  /** The facet's own work between seeing the end and sending the commit. */
  facetMs: number | null;
  /** The facet's round trip to the provider: commit sent -> commit acked. */
  providerRttMs: number | null;
  /** Ack -> first audio delta, on the facet's clock. The model thinking. */
  providerThinkMs: number | null;
  /**
   * How far the facet fell behind the microphone during the utterance.
   *
   * The client speaks a fixed number of 20 ms frames paced to real time, so
   * the facet's own span from first frame to release should equal that. Any
   * excess is delivery backlog — audio the person finished speaking that the
   * facet was still working through when they let go, and every millisecond of
   * it lands on the answer.
   */
  backlogMs: number | null;
  /** Frames the facet had actually consumed by the release. */
  micFramesSeen: number | null;
  /** The longest single gap between frames: one stall, or steady drift. */
  maxFrameGapMs: number | null;
  /** Where that gap fell. Near zero means the lane was asleep, not slow. */
  maxFrameGapAfterFrames: number | null;
  /**
   * RAW CROSS-CLOCK LAGS, useless alone and decisive together.
   *
   * `downlinkLagMs` is the heard frame's arrival here minus the facet's stamp
   * on it: clock skew plus real delivery delay. `uplinkLagMs` is the facet
   * seeing the release minus the release here: MINUS the same skew plus real
   * delay. Neither is a duration — but the skew is constant for a run, so
   * each round's lag minus the RUN'S MINIMUM is that round's lateness on that
   * leg, and the two legs come apart without any clock protocol at all.
   */
  downlinkLagMs: number | null;
  uplinkLagMs: number | null;
}

/** A direct turn, measured on the socket it was spoken into. */
interface DirectTurn extends Turn {
  /** The provider's ack of the commit -> its first audio delta. Think time. */
  providerMs: number | null;
  /** Commit sent -> commit acked, from this Mac. The facet's counterpart term. */
  providerRttMs: number | null;
}

/** The session shape the facet sends, so both halves ask for the same thing. */
const sessionUpdate = {
  type: "session.update",
  session: {
    type: "realtime",
    audio: {
      input: { format: { type: "audio/pcm", rate: 16_000 }, turn_detection: null },
      output: { format: { type: "audio/pcm", rate: 16_000 }, voice: "eve" },
    },
  },
};

/** One provider socket, held open across rounds exactly as the facet holds its own. */
async function dialProvider(baseUrl: string, model: string, apiKey: string) {
  const target = new URL(baseUrl);
  target.searchParams.set("model", model);
  const { WebSocket } = await import("ws");
  const socket = new WebSocket(target.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  /** Arrival times HERE, by provider event type, newest last — our clock. */
  const seen = new Map<string, number[]>();
  const note = (type: string) => {
    const times = seen.get(type) ?? [];
    times.push(Date.now());
    seen.set(type, times);
  };
  const ready = new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", (raw: Buffer) => {
      let event: { type?: string };
      try {
        event = JSON.parse(raw.toString("utf8")) as { type?: string };
      } catch {
        return;
      }
      if (typeof event.type !== "string") return;
      note(event.type);
      if (event.type === "session.created") socket.send(JSON.stringify(sessionUpdate));
      if (event.type === "session.updated") resolve();
    });
  });
  return {
    socket,
    ready,
    /** The first arrival of `type` at or after `sinceAtDeviceMs`, or null. */
    firstAfter: (type: string, sinceAtDeviceMs: number) =>
      seen.get(type)?.find((atDeviceMs) => atDeviceMs >= sinceAtDeviceMs) ?? null,
    send: (message: Record<string, unknown>) => socket.send(JSON.stringify(message)),
  };
}

/** One speaker frame, as much of it as a latency probe needs. */
export interface HeardFrame {
  /** When it reached this process, on THIS process's clock. */
  atDeviceMs: number;
  /** The facet's own stamp on it, on the FACET's clock. Never subtract these. */
  sentAtFacetMs: number;
  /** The call it belongs to. Delta numbers only mean anything inside one. */
  conversationId: string;
  /**
   * Which provider delta this chunk was cut from, as the facet numbered it.
   *
   * v2 stamps this on every frame, so a probe telling one answer from the next
   * needs no counting of its own. It restarts at zero on a fresh socket, which
   * is why the key below is scoped to the call.
   */
  fromGrokAudioDeltaSeq: number;
  /** False for a frame whose only job is a clear or an end-of-answer marker. */
  hasAudio: boolean;
}

/** A chunk of generated audio's identity on the wire: a call, and a delta in it. */
export const answerKey = (frame: Pick<HeardFrame, "conversationId" | "fromGrokAudioDeltaSeq">) =>
  `${frame.conversationId}:${frame.fromGrokAudioDeltaSeq}`;

/**
 * The first frame that can only belong to the answer this press asked for.
 *
 * THE DELTA NUMBER IS NOT A RUN-WIDE CLOCK, and reading it as one is what once
 * made a working facet look like a dead server. The rule was "a frame numbered
 * above the highest seen so far", which is sound inside one call and
 * meaningless across two: the counter lives on the socket, and a call that
 * hangs up takes it away. Every answer was then numbered 1, so from round two
 * the probe sat out its full 30-second deadline waiting for a 2 that no longer
 * existed, and reported five silent rounds against a facet that had answered
 * all five.
 *
 * Scoping the comparison to the conversation is what makes it true again, and
 * it is still the honest match for the thing this guards against: the facet
 * paces a long answer out over its whole playing time, so frames of the
 * PREVIOUS answer are still arriving when the next button goes down. Those
 * carry a pair this turn has already seen; the answer it is waiting for cannot.
 *
 * REQUIRING AUDIO is the v2 half of the rule. That lane also carries frames
 * with no samples in them — the clear that a press puts out, and the marker
 * that ends an answer — and the clear is emitted BY THIS PRESS, microseconds
 * after the button goes down. Timing that would report a few milliseconds for
 * an answer nobody has generated yet.
 */
export function firstFrameOfNewAnswer(
  frames: readonly HeardFrame[],
  seenBeforeThePress: ReadonlySet<string>,
  releasedAtDeviceMs: number,
): HeardFrame | undefined {
  return frames.find(
    (frame) =>
      frame.hasAudio &&
      frame.atDeviceMs >= releasedAtDeviceMs &&
      !seenBeforeThePress.has(answerKey(frame)),
  );
}

/** The facet's stamps for one turn, all on the facet's own clock. */
interface TurnMarks {
  endSeenAtFacetMs: number;
  commitSentAtFacetMs: number | null;
  committedAckAtFacetMs: number | null;
  firstDeltaAtFacetMs: number;
  firstMicFrameAtFacetMs: number | null;
  micFrames: number;
  maxMicFrameGapMs: number;
  maxMicFrameGapAfterFrames: number;
}

export async function pttMarginal(options: PttMarginalOptions) {
  const apiKey = process.env.APP_CONFIG_X_AI_API_KEY?.trim() ?? "";
  if (apiKey === "") throw new Error("APP_CONFIG_X_AI_API_KEY is required for the direct half.");
  const streamPath = options.streamPath ?? "/agents/voice2/marginal-1";
  const rounds = options.rounds ?? 8;
  const settleMs = options.settleMs ?? 8_000;
  const batch = Math.max(1, options.framesPerAppend ?? 12);
  const baseUrl = options.grokBaseUrl ?? "https://api.x.ai/v1/realtime";
  const model = options.model ?? "grok-voice-think-fast-2.0";
  const spoken = framesFromWav(options.micWav);
  console.log(
    `  ${spoken.length} frames (${((spoken.length * FRAME_MS) / 1000).toFixed(1)}s) from ` +
      `${options.micWav}, ${rounds} rounds, alternating stream and direct, ` +
      `keep-warm ${(options.keepWarmSeconds ?? 3) > 0 ? `${options.keepWarmSeconds ?? 3}s` : "OFF"}\n`,
  );

  using itx = await connectProject(options);
  const stream = itx.streams.get(streamPath);

  /*
   * THE LANE STAYS WARM FOR THE WHOLE RUN. The stream tears down idle
   * delivery connections after five seconds of quiet, and every between-turn
   * gap here is longer than that — so without this, every round pays the
   * resurrection (an alarm hop plus a facet re-dial up, a page plus a re-dial
   * down) and the run measures the teardown policy as much as the lane.
   */
  const keepWarmSeconds = options.keepWarmSeconds ?? 3;
  const keepWarmTimer =
    keepWarmSeconds > 0
      ? setInterval(() => {
          void stream
            .append({
              type: "events.iterate.com/voice-agent/keepalive",
              ephemeral: true,
              payload: {},
            })
            .catch(() => undefined);
        }, keepWarmSeconds * 1_000)
      : null;

  /*
   * ONLY WHAT A DEVICE SUBSCRIBES TO. The provider's verbatim `grok-event`
   * lane would give a second, independent anchor — but it carries every audio
   * delta, so subscribing to it roughly doubles the downlink this probe
   * receives and inflates the number the probe exists to measure.
   */
  let spkAt: HeardFrame[] = [];
  /*
   * Every (call, delta) pair this run has heard, for the whole run rather
   * than the turn: `spkAt` is cleared per turn, so a straggler from the
   * previous answer arrives into an empty list and would otherwise look new.
   * See `firstFrameOfNewAnswer` for why the pair, and not the number alone.
   */
  const answersSeen = new Set<string>();
  let lastSpkAtDeviceMs = 0;
  /** The facet's stamps for the turn in flight; at most one per turn. */
  const timing: TurnMarks[] = [];
  let faultThisTurn = false;
  /* Lifetime counts, so "no answer" can be told apart from "no delivery". */
  const delivered = new Map<string, number>();
  const connection = await stream.openConnection({
    connectionKey: `ptt-marginal-${Date.now()}`,
    eventTypes: [
      "events.iterate.com/voice-agent/spk-frame",
      "events.iterate.com/voice-agent/turn-timing",
      "events.iterate.com/voice-agent/call-started",
      "events.iterate.com/voice-agent/provider-error",
      "events.iterate.com/voice-agent/conversation-ended",
    ],
    processEventBatch: (payloadBatch: { events?: { type: string; payload?: unknown }[] }) => {
      const atDeviceMs = Date.now();
      for (const event of payloadBatch.events ?? []) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        delivered.set(event.type, (delivered.get(event.type) ?? 0) + 1);
        if (event.type === "events.iterate.com/voice-agent/spk-frame") {
          lastSpkAtDeviceMs = atDeviceMs;
          const frame: HeardFrame = {
            atDeviceMs,
            sentAtFacetMs:
              typeof payload.sentAtFacetMs === "number" ? payload.sentAtFacetMs : Number.NaN,
            conversationId: String(payload.conversationId ?? ""),
            fromGrokAudioDeltaSeq: Number(payload.fromGrokAudioDeltaSeq ?? 0),
            hasAudio: typeof payload.pcm === "string" && payload.pcm !== "",
          };
          spkAt.push(frame);
          if (frame.hasAudio) answersSeen.add(answerKey(frame));
          continue;
        }
        if (event.type === "events.iterate.com/voice-agent/provider-error") {
          console.log(`  provider error: ${String(payload.message).slice(0, 200)}`);
          faultThisTurn = true;
          continue;
        }
        if (event.type === "events.iterate.com/voice-agent/turn-timing") {
          timing.push({
            endSeenAtFacetMs: Number(payload.endSeenAtFacetMs),
            commitSentAtFacetMs:
              payload.commitSentAtFacetMs === null ? null : Number(payload.commitSentAtFacetMs),
            committedAckAtFacetMs:
              payload.committedAckAtFacetMs === null ? null : Number(payload.committedAckAtFacetMs),
            firstDeltaAtFacetMs: Number(payload.firstDeltaAtFacetMs),
            firstMicFrameAtFacetMs:
              payload.firstMicFrameAtFacetMs === null
                ? null
                : Number(payload.firstMicFrameAtFacetMs),
            micFrames: Number(payload.micFrames ?? 0),
            maxMicFrameGapMs: Number(payload.maxMicFrameGapMs ?? 0),
            maxMicFrameGapAfterFrames: Number(payload.maxMicFrameGapAfterFrames ?? 0),
          });
          continue;
        }
        /*
         * `call-started` and `conversation-ended` land here to be COUNTED, not
         * to condemn a round: one call-started for a whole run is the healthy
         * shape (a conversation is one call across many presses) and the count
         * is reported at the end. Only the stream saying the call went wrong
         * makes a round unusable.
         */
      }
    },
  });

  /**
   * What a round trip to the Durable Object costs, and nothing else.
   *
   * This used to append a `ping` and wait for the facet to append a `pong`
   * carrying its clock, so the answer could be split into an uplink and a
   * downlink. Both the ping pair and the clock alignment are gone: a
   * WebSocket already knows whether it is alive, and the split was never
   * worth its error bars — a skew estimate assumes symmetric legs, so it
   * carried +/-50ms that the SUM of the two halves did not.
   *
   * The honest number needs no clock alignment at all. `totalMs` is measured
   * here, and `turn-timing`'s provider RTT and think time are facet-clock
   * DURATIONS, so subtracting them leaves everything that is ours with the
   * skew cancelled out.
   *
   * IT PROBES WITH `warmup`, WHICH IS THE ONLY EVENT THAT STARTS NOTHING. It
   * used to append an empty `mic-frame`, and on v2 that is not a null probe at
   * all: a microphone frame is what OPENS A CALL, so three of them between
   * rounds would dial the provider from a probe measuring the cost of not
   * dialling it.
   */
  async function probeAppendRtt(): Promise<number | null> {
    if (options.appendProbe !== true) return null;
    const trips: number[] = [];
    for (let probe = 0; probe < APPEND_PROBES; probe++) {
      const atDeviceMs = Date.now();
      await discardRpcResult(
        stream.append({
          type: "events.iterate.com/voice-agent/warmup",
          payload: { token: `append-rtt-${atDeviceMs}-${probe}` },
        }),
      );
      trips.push(Date.now() - atDeviceMs);
    }
    return median(trips);
  }

  /**
   * Wait until the answer has actually stopped arriving.
   *
   * A fixed settle is a guess, and the wrong one in both directions: the model
   * rambles for fifteen seconds sometimes, so the next press lands in the
   * middle of the previous answer, and it finishes in four seconds other
   * times, so the run wastes the difference. Quiet on the speaker lane is the
   * real signal.
   */
  async function settle(): Promise<void> {
    const deadline = Date.now() + settleMs;
    /* A floor as well as a ceiling: the answer may not have started yet. */
    await sleep(Math.min(1_500, settleMs));
    while (Date.now() < deadline && Date.now() - lastSpkAtDeviceMs < 1_500) await sleep(100);
  }

  /**
   * Speak the utterance into the stream, paced to real time, awaiting nothing
   * — and let go in the SAME append as the last frames.
   *
   * Every batch but the last is fire-and-forget, which is the whole point:
   * capture must never block on the server. But a fire-and-forget append can
   * be overtaken by the one issued after it, and a release that overtakes its
   * own audio makes the provider hear the tail as a new utterance and cancel
   * the answer. Riding in the final batch makes the ordering a fact rather
   * than a hope, and costs a round trip less than sending it separately.
   */
  async function speakToStream(pressedAtDeviceMs: number): Promise<number> {
    for (let index = 0; index < spoken.length; index += batch) {
      /* A batch cannot be sent before the audio in it has been captured. */
      const due = pressedAtDeviceMs + Math.min(index + batch, spoken.length) * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const events = [];
      for (let offset = 0; offset < batch && index + offset < spoken.length; offset++) {
        events.push({
          type: "events.iterate.com/voice-agent/mic-frame" as const,
          ephemeral: true as const,
          payload: {
            deviceMicFrameSeq: index + offset,
            pcm: spoken[index + offset]!,
            capturedAtDeviceMs: pressedAtDeviceMs + (index + offset) * FRAME_MS,
          },
        });
      }
      if (index + batch >= spoken.length) {
        const releasedAtDeviceMs = Date.now();
        await discardRpcResult(
          stream.append(...events, {
            type: "events.iterate.com/voice-agent/ptt-end",
            ephemeral: true,
            payload: {},
          }),
        );
        return releasedAtDeviceMs;
      }
      void stream.append(...events).catch(() => undefined);
    }
    return Date.now();
  }

  async function streamTurn(appendRttMs: number | null = null): Promise<StreamTurn> {
    spkAt = [];
    timing.length = 0;
    faultThisTurn = false;
    const answersBefore = new Set(answersSeen);
    const pressedAtDeviceMs = Date.now();
    await discardRpcResult(
      stream.append({
        type: "events.iterate.com/voice-agent/ptt-start",
        ephemeral: true,
        payload: {},
      }),
    );
    const releasedAtDeviceMs = await speakToStream(pressedAtDeviceMs);

    const deadline = Date.now() + 30_000;
    let heard: HeardFrame | undefined;
    while (Date.now() < deadline) {
      heard = firstFrameOfNewAnswer(spkAt, answersBefore, releasedAtDeviceMs);
      if (heard !== undefined) break;
      await sleep(5);
    }
    /*
     * THE ANSWER ARRIVING IS NOT THE REPORT ARRIVING. The facet appends
     * `turn-timing` just before the first frame of audio, but the two are
     * separate appends on a lane that batches, so the frame can be delivered
     * in one batch and the report in the next. Breaking out of the loop the
     * instant audio is heard therefore drops the attribution for that round —
     * observed as a round with a perfectly good `totalMs` and every term null.
     * A short grace period costs nothing and is not part of any measurement:
     * the total was stamped from `heard`, before this wait began.
     */
    const reportDeadline = Date.now() + TURN_REPORT_GRACE_MS;
    while (timing.length === 0 && heard !== undefined && Date.now() < reportDeadline) {
      await sleep(5);
    }
    const marks = timing.at(-1) ?? null;
    const span = (from: number | null | undefined, to: number | null | undefined) =>
      from === null || from === undefined || to === null || to === undefined
        ? null
        : Math.round(to - from);
    const facetSide = {
      facetMs: span(marks?.endSeenAtFacetMs, marks?.commitSentAtFacetMs),
      providerRttMs: span(marks?.commitSentAtFacetMs, marks?.committedAckAtFacetMs),
      providerThinkMs: span(marks?.committedAckAtFacetMs, marks?.firstDeltaAtFacetMs),
      /* The client spoke `spoken.length` frames of FRAME_MS each; anything the
       * facet's own span has beyond that is time it spent catching up. */
      backlogMs:
        marks === null || marks.firstMicFrameAtFacetMs === null
          ? null
          : Math.round(
              marks.endSeenAtFacetMs -
                marks.firstMicFrameAtFacetMs -
                (spoken.length - 1) * FRAME_MS,
            ),
      micFramesSeen: marks?.micFrames ?? null,
      maxFrameGapMs: marks?.maxMicFrameGapMs ?? null,
      maxFrameGapAfterFrames: marks?.maxMicFrameGapAfterFrames ?? null,
    };
    if (heard === undefined) {
      return {
        totalMs: null,
        ourMs: null,
        appendRttMs,
        clean: !faultThisTurn,
        downlinkLagMs: null,
        uplinkLagMs: null,
        ...facetSide,
      };
    }
    const totalMs = heard.atDeviceMs - releasedAtDeviceMs;
    const downlinkLagMs = Number.isNaN(heard.sentAtFacetMs)
      ? null
      : Math.round(heard.atDeviceMs - heard.sentAtFacetMs);
    const uplinkLagMs =
      marks === null ? null : Math.round(marks.endSeenAtFacetMs - releasedAtDeviceMs);
    const provider =
      facetSide.providerRttMs === null || facetSide.providerThinkMs === null
        ? null
        : facetSide.providerRttMs + facetSide.providerThinkMs;
    return {
      totalMs,
      ourMs: provider === null ? null : totalMs - provider,
      appendRttMs,
      clean: !faultThisTurn,
      downlinkLagMs,
      uplinkLagMs,
      ...facetSide,
    };
  }

  async function directTurn(
    session: Awaited<ReturnType<typeof dialProvider>>,
  ): Promise<DirectTurn> {
    const pressedAtDeviceMs = Date.now();
    /* Paced exactly as the stream half paces it, so both put audio on the wire
     * at the same rate rather than one of them dumping it in a burst. */
    for (let index = 0; index < spoken.length; index++) {
      const due = pressedAtDeviceMs + index * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      session.send({ type: "input_audio_buffer.append", audio: spoken[index]! });
    }
    const releasedAtDeviceMs = Date.now();
    session.send({ type: "input_audio_buffer.commit" });
    session.send({ type: "response.create" });

    const deadline = Date.now() + 30_000;
    let audioAtDeviceMs: number | null = null;
    while (Date.now() < deadline) {
      audioAtDeviceMs = session.firstAfter("response.output_audio.delta", releasedAtDeviceMs);
      if (audioAtDeviceMs !== null) break;
      await sleep(5);
    }
    const committedAtDeviceMs = session.firstAfter(
      "input_audio_buffer.committed",
      releasedAtDeviceMs,
    );
    return {
      totalMs: audioAtDeviceMs === null ? null : audioAtDeviceMs - releasedAtDeviceMs,
      providerMs:
        audioAtDeviceMs === null || committedAtDeviceMs === null
          ? null
          : audioAtDeviceMs - committedAtDeviceMs,
      providerRttMs: committedAtDeviceMs === null ? null : committedAtDeviceMs - releasedAtDeviceMs,
      clean: true,
    };
  }

  const direct = await dialProvider(baseUrl, model, apiKey);
  const streamTurns: StreamTurn[] = [];
  const directTurns: DirectTurn[] = [];

  try {
    await direct.ready;

    /*
     * A WARM-UP TURN THAT IS NOT MEASURED. It warms everything one-off around
     * the rounds: a cold Durable Object, a facet class being materialised for
     * the first time, a subscription's first delivery, and — now that a
     * conversation is one call across many presses — the provider handshake
     * every later round rides on. Those cost seconds and belong to no round.
     */
    console.log("  warming the stream's Durable Object (unmeasured)...");
    const warm = await streamTurn();
    console.log(`  warm-up ${warm.totalMs === null ? "TIMEOUT" : `${warm.totalMs}ms`}\n`);
    await settle();

    for (let round = 0; round < rounds; round++) {
      const viaStream = await streamTurn(await probeAppendRtt());
      streamTurns.push(viaStream);
      await settle();

      const viaDirect = await directTurn(direct);
      directTurns.push(viaDirect);

      const show = (value: number | null, unit = "ms") =>
        value === null ? "     -" : `${String(value).padStart(4)}${unit}`;
      console.log(
        `  round ${String(round + 1).padStart(2)}  ` +
          `stream ${show(viaStream.totalMs)} = ours ${show(viaStream.ourMs)} + ` +
          `xai-rtt ${show(viaStream.providerRttMs)} + think ${show(viaStream.providerThinkMs)} ` +
          `(facet ${show(viaStream.facetMs)}) ` +
          `[backlog ${show(viaStream.backlogMs)}, ` +
          `gap ${show(viaStream.maxFrameGapMs)}@${String(viaStream.maxFrameGapAfterFrames ?? "-")}, ` +
          `frames ${String(viaStream.micFramesSeen ?? "-")}]  ` +
          `direct ${show(viaDirect.totalMs)} = xai-rtt ${show(viaDirect.providerRttMs)} + ` +
          `think ${show(viaDirect.providerMs)}` +
          `${viaStream.clean ? "" : "  [FAULT]"}`,
      );

      if (round + 1 < rounds) await settle();
    }
  } finally {
    console.log(
      `\n  delivered to this process: ${
        [...delivered].map(([type, count]) => `${type.split("/").pop()}=${count}`).join(" ") ||
        "nothing"
      }`,
    );
    if (keepWarmTimer !== null) clearInterval(keepWarmTimer);
    closeAndDisposeRpcHandle(connection);
    direct.socket.close();
  }

  const cleanStream = streamTurns.filter((turn) => turn.clean);
  const streamTotals = cleanStream.map((t) => t.totalMs).filter((v): v is number => v !== null);
  const directTotals = directTurns.map((t) => t.totalMs).filter((v): v is number => v !== null);
  const streamP50 = median(streamTotals);
  const directP50 = median(directTotals);

  const report = {
    kind: "ptt-marginal",
    streamPath,
    baseUrl,
    model,
    rounds,
    micWav: options.micWav,
    utteranceFrames: spoken.length,
    framesPerAppend: batch,
    keepWarmSeconds,
    /** Release -> first answer audio, with the provider already connected. */
    streamReleaseToAudioMs: summarize(streamTotals),
    directReleaseToAudioMs: summarize(directTotals),
    /** The headline: what the stream costs on top of talking to xAI ourselves. */
    marginalMs: streamP50 === null || directP50 === null ? null : streamP50 - directP50,
    /** Everything that is ours, clocks cancelled. */
    ourMs: summarize(cleanStream.map((t) => t.ourMs).filter((v): v is number => v !== null)),
    /** The facet's own work, end seen to commit sent. */
    facetMs: summarize(cleanStream.map((t) => t.facetMs).filter((v): v is number => v !== null)),
    /** Commit -> ack, from the facet's colo and from this Mac, for comparison. */
    providerRttFromFacetMs: summarize(
      cleanStream.map((t) => t.providerRttMs).filter((v): v is number => v !== null),
    ),
    providerRttFromHereMs: summarize(
      directTurns.map((t) => t.providerRttMs).filter((v): v is number => v !== null),
    ),
    /** Ack -> first delta, as the facet saw it. */
    providerThinkFromFacetMs: summarize(
      cleanStream.map((t) => t.providerThinkMs).filter((v): v is number => v !== null),
    ),
    /** The worst single stall in the delivery lane during an utterance. */
    maxFrameGapMs: summarize(
      cleanStream.map((t) => t.maxFrameGapMs).filter((v): v is number => v !== null),
    ),
    /** And how far into the utterance it fell: 0-2 means a cold lane waking. */
    maxFrameGapAfterFrames: summarize(
      cleanStream.map((t) => t.maxFrameGapAfterFrames).filter((v): v is number => v !== null),
    ),
    /** How far the delivery lane fell behind the microphone. */
    backlogMs: summarize(
      cleanStream.map((t) => t.backlogMs).filter((v): v is number => v !== null),
    ),
    /** Just reaching the Durable Object and back, with no delivery lane in it. */
    appendRttMs: summarize(
      cleanStream.map((t) => t.appendRttMs).filter((v): v is number => v !== null),
    ),
    /**
     * THE TWO LEGS, SEPARATED WITHOUT A CLOCK PROTOCOL.
     *
     * Each round's raw lag minus the run's minimum lag on that leg is that
     * round's LATENESS: how much longer the leg took than the best this run
     * ever saw. The floors themselves (skew plus best-case delay, equal and
     * opposite skews) are reported too — their SUM is the run's best-case
     * round trip through the delivery machinery, skew cancelled.
     */
    downlinkLatenessMs: latenesses(cleanStream.map((t) => t.downlinkLagMs)),
    uplinkLatenessMs: latenesses(cleanStream.map((t) => t.uplinkLagMs)),
    bestCaseLegRoundTripMs: (() => {
      const down = cleanStream.map((t) => t.downlinkLagMs).filter((v): v is number => v !== null);
      const up = cleanStream.map((t) => t.uplinkLagMs).filter((v): v is number => v !== null);
      return down.length === 0 || up.length === 0 ? null : Math.min(...down) + Math.min(...up);
    })(),
    /** The model's own time, measured where nothing of ours can colour it. */
    providerThinkMs: summarize(
      directTurns.map((t) => t.providerMs).filter((v): v is number => v !== null),
    ),
    /**
     * Did this process hear ANYTHING from the stream?
     *
     * A run whose connection never registered looks exactly like a facet that
     * answered nothing: every round times out and every stream number is null.
     * They are opposite diagnoses and the report used to give them the same
     * words. MEASURED, twice, on preview-3 immediately after a run that passed
     * 6/6: the stream's own log held a `call-started` and a
     * `conversation-accepted` for every press, with no
     * `connection-opened` for this probe anywhere in the window — the facet had
     * answered all of them and nothing reached here. Warming the stream (a
     * `talk --setup-only`) immediately before the run made it register again.
     */
    deliveredNothing: delivered.size === 0,
    /**
     * HOW MANY CALLS THIS RUN TOOK, and the headline number for the change
     * that made a conversation one call across many presses.
     *
     * One — the warm-up's — for the whole run is healthy. One per press is
     * what the facet used to do, and it is what a caller feels as a provider
     * handshake sitting in front of every answer. More than one and fewer
     * than one-per-press means something was re-dialled mid-run: read
     * `conversation-ended` on the stream for why.
     */
    callsStarted: delivered.get("events.iterate.com/voice-agent/call-started") ?? 0,
    callsEnded: delivered.get("events.iterate.com/voice-agent/conversation-ended") ?? 0,
    streamTurns,
    directTurns,
  };

  const runsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../.voicelab-runs",
  );
  fs.mkdirSync(runsDir, { recursive: true });
  const out = path.join(
    runsDir,
    `ptt-marginal-${new Date().toISOString().replace(/\D/g, "")}.json`,
  );
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  const line = (label: string, summary: ReturnType<typeof summarize>) => {
    if (summary === null) return;
    console.log(
      `  ${label.padEnd(22)} p50 ${String(summary.p50).padStart(5)}ms  ` +
        `p90 ${String(summary.p90).padStart(5)}ms  max ${String(summary.max).padStart(5)}ms  ` +
        `(n=${summary.n})`,
    );
  };
  console.log("");
  line("stream release→audio", report.streamReleaseToAudioMs);
  line("  of which ours", report.ourMs);
  line("    incl. backlog", report.backlogMs);
  line("  facet's own work", report.facetMs);
  line("  facet→xAI→facet", report.providerRttFromFacetMs);
  line("  model thinking", report.providerThinkFromFacetMs);
  line("uplink lateness", report.downlinkLatenessMs === null ? null : report.uplinkLatenessMs);
  line("downlink lateness", report.downlinkLatenessMs);
  if (report.bestCaseLegRoundTripMs !== null) {
    console.log(
      `  ${"best-case legs RTT".padEnd(22)}     ${String(report.bestCaseLegRoundTripMs).padStart(5)}ms  (run floor, skew cancelled)`,
    );
  }
  line("direct release→audio", report.directReleaseToAudioMs);
  line("  mac→xAI→mac", report.providerRttFromHereMs);
  line("  model thinking", report.providerThinkMs);
  line("  append to DO only", report.appendRttMs);
  if (report.marginalMs !== null) {
    console.log(`\n  MARGINAL OVERHEAD  ${report.marginalMs > 0 ? "+" : ""}${report.marginalMs}ms`);
  }
  /*
   * A COUNT OF ZERO IS NOT A COUNT OF RE-DIALS, and this line used to say it
   * was. `call-started` is DURABLE, and a run whose connection received only
   * the ephemeral lanes reports zero of them while the facet was answering
   * every press — measured, on a run where 541 speaker frames and 21 turn
   * reports arrived and not one call event did. "Re-dialled mid-run" is a
   * diagnosis; "nobody told us" is the absence of one.
   */
  const heardCallEvents = report.callsStarted + report.callsEnded > 0;
  console.log(
    `\n  CALLS  ${report.callsStarted} started, ${report.callsEnded} ended, ` +
      `for ${rounds + 1} presses` +
      `${
        !heardCallEvents
          ? "  [no call events delivered here; says nothing either way]"
          : report.callsStarted === 1
            ? "  (one conversation, as designed)"
            : "  [RE-DIALLED MID-RUN]"
      }`,
  );
  if (report.deliveredNothing) {
    console.log(
      "\n  NOTHING WAS MEASURED. This probe's connection received no events at all,\n" +
        "  so every stream number above is missing for want of a listener rather than\n" +
        "  for want of an answer. Read the stream's own log before blaming the facet:\n" +
        `  a \`call-started\` and a \`conversation-accepted\` per press means it answered.\n` +
        "  Warm the stream first (voicelab talk --setup-only) and run again.",
    );
  }
  console.log(`  ${out}\n`);
  if (streamTotals.length < rounds || directTotals.length < rounds) process.exitCode = 1;
  return report;
}
