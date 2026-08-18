// MARGINAL overhead: how much longer does an answer take because our stream
// is in the middle?
//
// Two probes used to answer half of this each, in separate runs minutes
// apart, against a provider whose think time wanders by hundreds of
// milliseconds between rounds — subtracting two such numbers measured the
// provider's mood as much as our plumbing. This runs BOTH halves in one
// process, alternating turn by turn, speaking the identical audio at
// identical pacing, so the difference between the two medians is ours and
// not the weather. (Those probes, `ptt-latency` and `ptt-baseline`, are
// deleted; this file replaced them.)
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
  /** Provider endpoint for the direct half. Defaults to the provider's own. */
  providerBaseUrl?: string;
  model?: string;
  /**
   * Which realtime voice provider BOTH halves speak to. The stream half's
   * provider is set on its birth certificate at setup; passing the same name
   * here makes the direct half dial the same provider so the comparison
   * stays like for like. The probe does not verify the two agree — the
   * per-round think times make a mismatch obvious in one glance.
   */
  provider?: "grok" | "openai";
  /**
   * MIXED SOAK: cycle short turns, very long answers, mid-answer
   * interjections, and quiet gaps that cross the idle-teardown boundary —
   * the conversation shapes a real call is made of, not just the easy one.
   * Needs --wav-dir holding short.wav, long.wav and barge.wav.
   */
  mixed?: boolean;
  /** Directory with the scenario utterances (PCM16 mono 16 kHz WAVs). */
  wavDir?: string;
  /** How far into an answer the interjection presses (ms). */
  bargeDelayMs?: number;
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
}

const FRAME_MS = 20;

/** The direct half's per-provider dial sheet. Mirrors voice-agent2.ts. */
const DIRECT_PROVIDERS = {
  grok: {
    url: "https://api.x.ai/v1/realtime",
    model: "grok-voice-think-fast-2.0",
    voice: "eve",
    rate: 16_000,
    keyEnvs: ["APP_CONFIG_X_AI_API_KEY", "XAI_API_KEY"],
  },
  openai: {
    url: "https://api.openai.com/v1/realtime",
    /* Tracks voice-agent2's default: a direct baseline on a different
     * model than the agent dials measures the models, not our overhead. */
    model: "gpt-realtime-2.1",
    voice: "marin",
    rate: 24_000,
    keyEnvs: ["OPENAI_API_KEY", "APP_CONFIG_OPENAI_API_KEY"],
  },
} as const;

/**
 * Linear PCM16 resample over base64, for the direct socket.
 *
 * A COPY of the agent's resampler ON PURPOSE. Importing it was tried and
 * broke every CLI command: config-repo files are WORKER code (they import
 * `cloudflare:workers` transitively) and this is a Node script — the module
 * boundary between the two runtimes is real, and thirteen duplicated lines
 * are its fee. The test suite imports the agent's copy and pins both ends.
 */
function resampleFrame(base64Frame: string, fromRate: number, toRate: number): string {
  if (fromRate === toRate) return base64Frame;
  const bytes = Buffer.from(base64Frame, "base64");
  const samples = Math.floor(bytes.length / 2);
  const outLength = Math.max(1, Math.round((samples * toRate) / fromRate));
  const out = Buffer.alloc(outLength * 2);
  for (let index = 0; index < outLength; index++) {
    const position = outLength === 1 ? 0 : (index * (samples - 1)) / (outLength - 1);
    const base = Math.floor(position);
    const fraction = position - base;
    const first = bytes.readInt16LE(base * 2);
    const second = base + 1 < samples ? bytes.readInt16LE((base + 1) * 2) : first;
    out.writeInt16LE((first + (second - first) * fraction) | 0, index * 2);
  }
  return out.toString("base64");
}

/** One scenario in the mixed soak. */
type RoundKind = "short" | "long" | "barge";

/**
 * The mixed cycle: the shapes a real conversation is made of. The 8s and 30s
 * gaps deliberately cross the old five-second idle-teardown boundary, and the
 * long prompt asks for an answer measured in tens of seconds so the downlink
 * is judged under sustained egress rather than a two-second reply.
 */
const MIXED_CYCLE: { kind: RoundKind; preGapMs: number }[] = [
  { kind: "short", preGapMs: 0 },
  { kind: "long", preGapMs: 0 },
  { kind: "barge", preGapMs: 0 },
  { kind: "short", preGapMs: 8_000 },
  { kind: "long", preGapMs: 2_000 },
  { kind: "short", preGapMs: 30_000 },
];
/** 20 ms of 16 kHz PCM16 = 320 samples = 640 bytes. */
const FRAME_SAMPLES = 320;
/** Round-trip probes per round; the median of three beats any one. */
const APPEND_PROBES = 3;
/** How long to wait for a turn's attribution after its audio has arrived. */
const TURN_REPORT_GRACE_MS = 750;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An awaited append with a deadline. Twice now a run has hung FOREVER on a
 * dropped itx WebSocket — an RPC on a dead session resolves never, and a
 * probe that awaits it unbounded turns one network blip into a killed run
 * and a zombie press replayed into somebody's stream. Five seconds is an
 * eternity for an append; past it the ROUND fails, not the run.
 */
async function appendWithDeadline(work: Promise<unknown>, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      discardRpcResult(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} unacknowledged after 5s`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
  /** Which scenario this round played. */
  kind: RoundKind;
  /**
   * THE ANSWER'S DELIVERY HEALTH, judged where the listener sits. `pcmMs` is
   * how much audio arrived, `wallMs` how long arriving took from first frame
   * to the end-of-answer marker; a rate at or above one means delivery kept
   * pace with playback for the WHOLE answer, however long. `maxAnswerGapMs`
   * is the longest silence between two audio frames mid-answer — the
   * would-be stutter (the head start the pacer grants absorbs gaps up to
   * four seconds, so the number to fear is 4000, not 200).
   */
  answerPcmMs: number | null;
  answerWallMs: number | null;
  maxAnswerGapMs: number | null;
  sawEndOfAnswer: boolean;
  /** Interjection metrics; null on rounds that did not interject. */
  bargeClearMs: number | null;
  bargeAnswerMs: number | null;
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
/** The session shape the facet sends, so both halves ask for the same thing. */
function sessionUpdateFor(rate: number, voice: string) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      audio: {
        input: { format: { type: "audio/pcm", rate }, turn_detection: null },
        output: { format: { type: "audio/pcm", rate }, voice },
      },
    },
  };
}

/** One provider socket, held open across rounds exactly as the facet holds its own. */
async function dialProvider(
  baseUrl: string,
  model: string,
  apiKey: string,
  rate: number,
  voice: string,
) {
  const sessionUpdate = sessionUpdateFor(rate, voice);
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
  fromProviderDeltaSeq: number;
  /** False for a frame whose only job is a clear or an end-of-answer marker. */
  hasAudio: boolean;
  /** The frame asks the device to drop everything queued first. */
  clearsBuffer: boolean;
  /** Nothing more is coming for this answer. */
  lastOfAnswer: boolean;
  /** Milliseconds of audio this frame carries. */
  pcmMs: number;
}

/** A chunk of generated audio's identity on the wire: a call, and a delta in it. */
export const answerKey = (frame: Pick<HeardFrame, "conversationId" | "fromProviderDeltaSeq">) =>
  `${frame.conversationId}:${frame.fromProviderDeltaSeq}`;

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
  const providerName = options.provider ?? "grok";
  const directProvider = DIRECT_PROVIDERS[providerName];
  const keyEnv = directProvider.keyEnvs.find((name) => process.env[name]?.trim());
  const apiKey = keyEnv === undefined ? "" : (process.env[keyEnv]?.trim() ?? "");
  if (apiKey === "") {
    throw new Error(
      `one of ${directProvider.keyEnvs.join("/")} is required for the direct ${providerName} half.`,
    );
  }
  const streamPath = options.streamPath ?? "/agents/voice2/marginal-1";
  const rounds = options.rounds ?? 8;
  const settleMs = options.settleMs ?? 8_000;
  const batch = Math.max(1, options.framesPerAppend ?? 12);
  const baseUrl = options.providerBaseUrl ?? directProvider.url;
  const model = options.model ?? directProvider.model;
  const spoken = framesFromWav(options.micWav);
  /* The direct half speaks at the provider's rate; the stream half stays
   * 16 kHz and the facet resamples, exactly as a device would experience it. */
  const toDirect = (frames: string[]) =>
    directProvider.rate === 16_000
      ? frames
      : frames.map((frame) => resampleFrame(frame, 16_000, directProvider.rate));
  /* The scenario utterances. Everything falls back to the main one, so a
   * plain run needs nothing new; --mixed without --wav-dir soaks with one
   * voice, which still exercises every path, just monotonously. */
  const wavFor = (name: string) => {
    if (options.wavDir === undefined) return spoken;
    const file = path.join(options.wavDir, name);
    return fs.existsSync(file) ? framesFromWav(file) : spoken;
  };
  const framesByKind: Record<RoundKind, string[]> = {
    short: spoken,
    long: wavFor("long.wav"),
    barge: spoken,
  };
  const bargeFrames = wavFor("barge.wav");
  const bargeDelayMs = options.bargeDelayMs ?? 1_500;
  const plans = Array.from({ length: rounds }, (_, index): { kind: RoundKind; preGapMs: number } =>
    options.mixed === true
      ? MIXED_CYCLE[index % MIXED_CYCLE.length]!
      : { kind: "short", preGapMs: 0 },
  );
  console.log(
    `  ${spoken.length} frames (${((spoken.length * FRAME_MS) / 1000).toFixed(1)}s) from ` +
      `${options.micWav}, ${rounds} rounds, alternating stream and direct\n`,
  );

  /*
   * THE CLIENT'S JOB IS TO BE CONNECTED. The /api socket is how the server
   * reaches a device (server-triggered conversations, pushes), so a real
   * client holds one open at all times and reconnects THE MOMENT it dies —
   * only the voice provider is dialed on demand. Sockets still die (isolate
   * churn, deploys; measured 2026-08-18 — no idle policy anywhere, pings
   * prevent nothing), so this probe does what the firmware transport does:
   * the close event triggers an immediate background reconnect, a press in
   * the gap pays whatever remains of it, and the cost is REPORTED. Never
   * pinned open with artificial traffic; never left dead until the next use.
   */
  let sessionGeneration = 0;
  async function dialSession() {
    const thisGeneration = ++sessionGeneration;
    return await connectProject(options, {
      onWebSocketClose: ({ code }) => {
        /* A socket this probe already buried announces its close late; only
         * the CURRENT session's death starts a reconnect. */
        if (thisGeneration !== sessionGeneration) return;
        void redial(`socket closed (${code})`).catch((error) => {
          console.log(`  reconnect failed: ${String(error).slice(0, 90)}`);
        });
      },
    });
  }
  let itx = await dialSession();
  let stream = itx.streams.get(streamPath);
  const redialMs: number[] = [];

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
  async function openProbeConnection() {
    return await stream.openConnection({
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
            const pcm = typeof payload.pcm === "string" ? payload.pcm : "";
            const frame: HeardFrame = {
              atDeviceMs,
              sentAtFacetMs:
                typeof payload.sentAtFacetMs === "number" ? payload.sentAtFacetMs : Number.NaN,
              conversationId: String(payload.conversationId ?? ""),
              fromProviderDeltaSeq: Number(payload.fromProviderDeltaSeq ?? 0),
              hasAudio: pcm !== "",
              clearsBuffer: payload.clearSpeakerBufferBeforeFrame === true,
              lastOfAnswer: payload.lastFrameOfAnswer === true,
              /* base64 -> bytes -> ms of 16 kHz PCM16 (32 bytes/ms). */
              pcmMs:
                pcm === ""
                  ? 0
                  : (Math.floor(pcm.length / 4) * 3 -
                      (pcm.endsWith("==") ? 2 : pcm.endsWith("=") ? 1 : 0)) /
                    32,
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
                payload.committedAckAtFacetMs === null
                  ? null
                  : Number(payload.committedAckAtFacetMs),
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
  }
  let connection = await openProbeConnection();

  /**
   * Bury the dead session, dial a fresh one, and say what it cost.
   *
   * Single-flight: the close hook, a failed append, and a failed round can
   * all notice the same death — they join one reconnect instead of racing
   * three.
   */
  let redialInFlight: Promise<void> | undefined;
  function redial(reason: string): Promise<void> {
    redialInFlight ??= (async () => {
      const startedAt = Date.now();
      try {
        closeAndDisposeRpcHandle(connection);
      } catch {
        /* Already dead — that is why we are here. */
      }
      try {
        (itx as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
      } catch {
        /* Same. */
      }
      itx = await dialSession();
      stream = itx.streams.get(streamPath);
      connection = await openProbeConnection();
      const tookMs = Date.now() - startedAt;
      redialMs.push(tookMs);
      console.log(`  session reconnected in ${tookMs}ms after: ${reason.slice(0, 90)}`);
    })().finally(() => {
      redialInFlight = undefined;
    });
    return redialInFlight;
  }

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
  async function speakToStream(pressedAtDeviceMs: number, frames: string[]): Promise<number> {
    for (let index = 0; index < frames.length; index += batch) {
      /* A batch cannot be sent before the audio in it has been captured. */
      const due = pressedAtDeviceMs + Math.min(index + batch, frames.length) * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const events = [];
      for (let offset = 0; offset < batch && index + offset < frames.length; offset++) {
        events.push({
          type: "events.iterate.com/voice-agent/mic-frame" as const,
          ephemeral: true as const,
          payload: {
            deviceMicFrameSeq: index + offset,
            pcm: frames[index + offset]!,
            capturedAtDeviceMs: pressedAtDeviceMs + (index + offset) * FRAME_MS,
          },
        });
      }
      if (index + batch >= frames.length) {
        const releasedAtDeviceMs = Date.now();
        await appendWithDeadline(
          stream.append(...events, {
            type: "events.iterate.com/voice-agent/ptt-end",
            ephemeral: true,
            payload: {},
          }),
          "release batch",
        );
        return releasedAtDeviceMs;
      }
      void stream.append(...events).catch(() => undefined);
    }
    return Date.now();
  }

  /** One press: ptt-start, the utterance paced to real time, ptt-end. */
  async function press(frames: string[]): Promise<number> {
    const pressedAtDeviceMs = Date.now();
    await appendWithDeadline(
      stream.append({
        type: "events.iterate.com/voice-agent/ptt-start",
        ephemeral: true,
        payload: {},
      }),
      "ptt-start",
    );
    return await speakToStream(pressedAtDeviceMs, frames);
  }

  /** Wait for the first frame that answers a press released at `releasedAt`. */
  async function hearAnswer(
    answersBefore: ReadonlySet<string>,
    releasedAtDeviceMs: number,
  ): Promise<HeardFrame | undefined> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const heard = firstFrameOfNewAnswer(spkAt, answersBefore, releasedAtDeviceMs);
      if (heard !== undefined) return heard;
      await sleep(5);
    }
    return undefined;
  }

  async function streamTurn(
    kind: RoundKind = "short",
    appendRttMs: number | null = null,
  ): Promise<StreamTurn> {
    spkAt = [];
    timing.length = 0;
    faultThisTurn = false;
    const answersBefore = new Set(answersSeen);
    const releasedAtDeviceMs = await press(framesByKind[kind]);
    const heard = await hearAnswer(answersBefore, releasedAtDeviceMs);
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
                (framesByKind[kind].length - 1) * FRAME_MS,
            ),
      micFramesSeen: marks?.micFrames ?? null,
      maxFrameGapMs: marks?.maxMicFrameGapMs ?? null,
      maxFrameGapAfterFrames: marks?.maxMicFrameGapAfterFrames ?? null,
    };
    if (heard === undefined) {
      return {
        kind,
        totalMs: null,
        ourMs: null,
        appendRttMs,
        clean: !faultThisTurn,
        downlinkLagMs: null,
        uplinkLagMs: null,
        answerPcmMs: null,
        answerWallMs: null,
        maxAnswerGapMs: null,
        sawEndOfAnswer: false,
        bargeClearMs: null,
        bargeAnswerMs: null,
        ...facetSide,
      };
    }
    const totalMs = heard.atDeviceMs - releasedAtDeviceMs;

    /*
     * THE INTERJECTION, on rounds that make one: wait until the long answer
     * is mid-flight, press again, and measure the two things a person feels —
     * how fast the old answer SHUTS UP (the clear frame reaching this
     * listener) and how fast the new one arrives. The clear rides a numbered
     * frame, so hearing it here is the same fact the device acts on.
     */
    let bargeClearMs: number | null = null;
    let bargeAnswerMs: number | null = null;
    /** Where the answer whose delivery health we judge begins. */
    let healthFromAtMs = heard.atDeviceMs;
    if (kind === "barge") {
      await sleep(bargeDelayMs);
      const answersBeforeBarge = new Set(answersSeen);
      const bargePressedAtMs = Date.now();
      const bargeReleasedAtMs = await press(bargeFrames);
      const clearDeadline = Date.now() + 10_000;
      while (Date.now() < clearDeadline) {
        const clear = spkAt.find(
          (frame) => frame.clearsBuffer && frame.atDeviceMs >= bargePressedAtMs,
        );
        if (clear !== undefined) {
          bargeClearMs = Math.round(clear.atDeviceMs - bargePressedAtMs);
          break;
        }
        await sleep(5);
      }
      const bargeHeard = await hearAnswer(answersBeforeBarge, bargeReleasedAtMs);
      if (bargeHeard !== undefined) {
        bargeAnswerMs = Math.round(bargeHeard.atDeviceMs - bargeReleasedAtMs);
        healthFromAtMs = bargeHeard.atDeviceMs;
      }
    }

    /*
     * HEAR THE ANSWER OUT. Long answers are the point of the soak, and the
     * delivery health of second forty is worth as much as second one. Ends on
     * the end-of-answer marker, or on the lane going quiet, or at a ceiling
     * that only a wedge would reach.
     */
    const answerCeilingAtMs = Date.now() + (kind === "short" ? 45_000 : 150_000);
    let sawEndOfAnswer = false;
    while (Date.now() < answerCeilingAtMs) {
      if (spkAt.some((frame) => frame.lastOfAnswer && frame.atDeviceMs >= healthFromAtMs)) {
        sawEndOfAnswer = true;
        break;
      }
      if (Date.now() - lastSpkAtDeviceMs > 2_500 && Date.now() > healthFromAtMs + 3_000) break;
      await sleep(50);
    }
    const answerAudio = spkAt.filter(
      (frame) => frame.hasAudio && frame.atDeviceMs >= healthFromAtMs,
    );
    let maxAnswerGapMs = 0;
    for (let index = 1; index < answerAudio.length; index++) {
      const gap = answerAudio[index]!.atDeviceMs - answerAudio[index - 1]!.atDeviceMs;
      if (gap > maxAnswerGapMs) maxAnswerGapMs = gap;
    }
    const answerPcmMs =
      answerAudio.length === 0
        ? null
        : Math.round(answerAudio.reduce((sum, frame) => sum + frame.pcmMs, 0));
    const answerWallMs =
      answerAudio.length < 2
        ? null
        : Math.round(answerAudio.at(-1)!.atDeviceMs - answerAudio[0]!.atDeviceMs);
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
      kind,
      totalMs,
      ourMs: provider === null ? null : totalMs - provider,
      appendRttMs,
      clean: !faultThisTurn,
      downlinkLagMs,
      uplinkLagMs,
      answerPcmMs,
      answerWallMs,
      maxAnswerGapMs: answerAudio.length < 2 ? null : Math.round(maxAnswerGapMs),
      sawEndOfAnswer,
      bargeClearMs,
      bargeAnswerMs,
      ...facetSide,
    };
  }

  async function directTurn(
    session: Awaited<ReturnType<typeof dialProvider>>,
    frames: string[] = toDirect(spoken),
  ): Promise<DirectTurn> {
    const pressedAtDeviceMs = Date.now();
    /* Paced exactly as the stream half paces it, so both put audio on the wire
     * at the same rate rather than one of them dumping it in a burst. */
    for (let index = 0; index < frames.length; index++) {
      const due = pressedAtDeviceMs + index * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      session.send({ type: "input_audio_buffer.append", audio: frames[index]! });
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

  const direct = await dialProvider(
    baseUrl,
    model,
    apiKey,
    directProvider.rate,
    directProvider.voice,
  );
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
      const plan = plans[round]!;
      if (plan.preGapMs > 0) await sleep(plan.preGapMs);
      let viaStream: StreamTurn;
      try {
        viaStream = await streamTurn(plan.kind, await probeAppendRtt());
      } catch (error) {
        /*
         * The eager close-hook reconnect usually beats this path to it; a
         * press still lands here when the socket died QUIETLY (half-open, no
         * close event) and the append deadline was the first to notice.
         * Either way this joins the single-flight reconnect and presses
         * again — the retry's own timing is honest (a fresh press on a live
         * session) and the reconnect cost is reported on its own line and in
         * the summary.
         */
        try {
          await redial(String(error));
          viaStream = await streamTurn(plan.kind, null);
          streamTurns.push(viaStream);
          await settle();
          const viaDirect = await directTurn(
            direct,
            toDirect(framesByKind[plan.kind === "barge" ? "long" : plan.kind]),
          );
          directTurns.push(viaDirect);
          if (round + 1 < rounds) await settle();
          continue;
        } catch (retryError) {
          console.log(
            `  round ${round + 1} FAILED after redial: ${String(retryError).slice(0, 100)}`,
          );
        }
        viaStream = {
          kind: plan.kind,
          totalMs: null,
          ourMs: null,
          appendRttMs: null,
          clean: false,
          downlinkLagMs: null,
          uplinkLagMs: null,
          answerPcmMs: null,
          answerWallMs: null,
          maxAnswerGapMs: null,
          sawEndOfAnswer: false,
          bargeClearMs: null,
          bargeAnswerMs: null,
          facetMs: null,
          providerRttMs: null,
          providerThinkMs: null,
          backlogMs: null,
          micFramesSeen: null,
          maxFrameGapMs: null,
          maxFrameGapAfterFrames: null,
        };
      }
      streamTurns.push(viaStream);
      await settle();

      /* The interjection has no direct twin; its direct half speaks the same
       * LONG prompt, so the long-answer parity still gets a sample. */
      const viaDirect = await directTurn(
        direct,
        toDirect(framesByKind[plan.kind === "barge" ? "long" : plan.kind]),
      );
      directTurns.push(viaDirect);

      const show = (value: number | null, unit = "ms") =>
        value === null ? "     -" : `${String(value).padStart(4)}${unit}`;
      console.log(
        `  round ${String(round + 1).padStart(2)} ${plan.kind.padEnd(5)} ` +
          `${viaStream.bargeClearMs === null ? "" : `[clear ${viaStream.bargeClearMs}ms answer ${String(viaStream.bargeAnswerMs ?? "-")}ms] `}` +
          `${viaStream.answerPcmMs === null ? "" : `[ans ${(viaStream.answerPcmMs / 1000).toFixed(1)}s gap ${String(viaStream.maxAnswerGapMs ?? "-")}ms${viaStream.sawEndOfAnswer ? "" : " NOEND"}] `}` +
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
    closeAndDisposeRpcHandle(connection);
    try {
      (itx as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    } catch {
      /* Session already gone. */
    }
    direct.socket.close();
  }

  const cleanStream = streamTurns.filter((turn) => turn.clean);
  /** Stream/direct pairs by round, so parity is judged per scenario kind. */
  const pairsByKind = new Map<RoundKind, { stream: number[]; direct: number[] }>();
  streamTurns.forEach((turn, index) => {
    const bucket = pairsByKind.get(turn.kind) ?? { stream: [], direct: [] };
    if (turn.totalMs !== null) bucket.stream.push(turn.totalMs);
    const twin = directTurns[index]?.totalMs;
    if (twin !== null && twin !== undefined) bucket.direct.push(twin);
    pairsByKind.set(turn.kind, bucket);
  });
  const half = Math.floor(streamTurns.length / 2);
  const ourHalves = {
    firstHalf: summarize(
      streamTurns
        .slice(0, half)
        .map((t) => t.ourMs)
        .filter((v): v is number => v !== null),
    ),
    secondHalf: summarize(
      streamTurns
        .slice(half)
        .map((t) => t.ourMs)
        .filter((v): v is number => v !== null),
    ),
  };
  const streamTotals = cleanStream.map((t) => t.totalMs).filter((v): v is number => v !== null);
  const directTotals = directTurns.map((t) => t.totalMs).filter((v): v is number => v !== null);
  const streamP50 = median(streamTotals);
  const directP50 = median(directTotals);

  const report = {
    kind: "ptt-marginal",
    provider: providerName,
    streamPath,
    baseUrl,
    model,
    rounds,
    micWav: options.micWav,
    utteranceFrames: spoken.length,
    framesPerAppend: batch,
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
    /**
     * What a press after a long pause pays to stand the session back up.
     * Zero entries is a run whose gaps never outlived the socket.
     */
    redialMs: summarize(redialMs),
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
    /** Per-scenario parity: the soak's whole point. */
    perKind: Object.fromEntries(
      [...pairsByKind].map(([kind, bucket]) => [
        kind,
        {
          stream: summarize(bucket.stream),
          direct: summarize(bucket.direct),
          marginalMs:
            median(bucket.stream) === null || median(bucket.direct) === null
              ? null
              : median(bucket.stream)! - median(bucket.direct)!,
        },
      ]),
    ),
    /** Degradation check: a long call's second half against its first. */
    ourHalves,
    /** Interjections: old answer shut up, new answer arrived. */
    bargeClearMs: summarize(
      cleanStream.map((t) => t.bargeClearMs).filter((v): v is number => v !== null),
    ),
    bargeAnswerMs: summarize(
      cleanStream.map((t) => t.bargeAnswerMs).filter((v): v is number => v !== null),
    ),
    /** The would-be stutter: worst mid-answer delivery gap, across all answers. */
    maxAnswerGapMs: summarize(
      cleanStream.map((t) => t.maxAnswerGapMs).filter((v): v is number => v !== null),
    ),
    answersWithoutEndMarker: cleanStream.filter((t) => t.totalMs !== null && !t.sawEndOfAnswer)
      .length,
    plans,
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
  line("session reconnect", report.redialMs);
  if (report.marginalMs !== null) {
    console.log(`\n  MARGINAL OVERHEAD  ${report.marginalMs > 0 ? "+" : ""}${report.marginalMs}ms`);
  }
  for (const [kind, parity] of Object.entries(report.perKind)) {
    console.log(
      `    ${kind.padEnd(6)} stream p50 ${String(parity.stream?.p50 ?? "-").padStart(5)}ms  ` +
        `direct p50 ${String(parity.direct?.p50 ?? "-").padStart(5)}ms  ` +
        `marginal ${parity.marginalMs === null ? "-" : `${parity.marginalMs > 0 ? "+" : ""}${parity.marginalMs}ms`}  ` +
        `(n=${parity.stream?.n ?? 0}/${parity.direct?.n ?? 0})`,
    );
  }
  if (report.ourHalves.firstHalf !== null && report.ourHalves.secondHalf !== null) {
    console.log(
      `  DEGRADATION  ours p50 first half ${report.ourHalves.firstHalf.p50}ms -> ` +
        `second half ${report.ourHalves.secondHalf.p50}ms`,
    );
  }
  line("interject: shut up in", report.bargeClearMs);
  line("interject: answer in", report.bargeAnswerMs);
  line("worst mid-answer gap", report.maxAnswerGapMs);
  if (report.answersWithoutEndMarker > 0) {
    console.log(`  ANSWERS MISSING END MARKER  ${report.answersWithoutEndMarker}`);
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
