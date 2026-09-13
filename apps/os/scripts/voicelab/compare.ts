// Compare one controlled GPT-Live answer on the direct provider wire and through
// a voice stream. Both legs use 16 kHz PCM in 100 ms appends and the exact
// instructions recorded by the stream session; timestamps are only subtracted
// within a local observer or within the same voice facet clock.
import type { VoiceAgentRpc } from "@iterate-com/voice-agent";
import { percentiles } from "./audio.ts";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { gapStatsOfGaps, liveProbe } from "./live-probe.ts";
import { openStream, sleep } from "./probe-audio.ts";
import { openWireCall } from "./wire-call.ts";

const RATE = 16_000;
const MIC_APPEND_MS = 100;

type AudioFrame = {
  atMs: number;
  payloadMs: number;
  hasSignal: boolean;
  receivedAtFacetMs?: number | null;
  sentAtFacetMs?: number | null;
  answerIndex?: number;
};

export interface VoiceCompareOptions extends VoicelabConnectOptions {
  /** Fresh stream to create and install before comparing. */
  streamPath?: string;
  /** Voice persona; the stream's durable session event supplies the full policy to the direct leg. */
  instructions?: string;
  /** Fixed commentary passed verbatim to both legs. */
  passage?: string;
}

/** Per-answer arrival pacing, bounded by first/last speaking PCM and including interior silence. */
export function answerMetrics(frames: AudioFrame[]) {
  const first = frames.findIndex((frame) => frame.hasSignal);
  const last = frames.findLastIndex((frame) => frame.hasSignal);
  if (first < 0 || last < first) return null;
  const answer = frames.slice(first, last + 1);
  let availablePcmMs = 0;
  let additionalStartupDelayMs = 0;
  const gaps: number[] = [];
  for (let index = 0; index < answer.length; index++) {
    const frame = answer[index]!;
    additionalStartupDelayMs = Math.max(
      additionalStartupDelayMs,
      frame.atMs - answer[0]!.atMs - availablePcmMs,
    );
    availablePcmMs += frame.payloadMs;
    if (index > 0) gaps.push(frame.atMs - answer[index - 1]!.atMs);
  }
  return {
    firstNonzeroAtMs: answer[0]!.atMs,
    lastNonzeroAtMs: answer.at(-1)!.atMs,
    audioMs: availablePcmMs,
    frames: answer.length,
    interiorSilentFrames: answer.filter((frame) => !frame.hasSignal).length,
    arrivalGapsMs: gapStatsOfGaps(gaps),
    additionalStartupDelayMs: Math.max(0, additionalStartupDelayMs),
  };
}

function metricsByAnswer(frames: AudioFrame[]) {
  return [...new Set(frames.map((frame) => frame.answerIndex ?? 0))]
    .sort((left, right) => left - right)
    .map((answerIndex) => ({
      answerIndex,
      metrics: answerMetrics(frames.filter((frame) => (frame.answerIndex ?? 0) === answerIndex)),
    }));
}

function requireReady(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function compare(options: VoiceCompareOptions): Promise<void> {
  const streamPath =
    options.streamPath ||
    `/agents/voice/compare-${new Date().toISOString().replace(/\D/g, "").slice(2, 14)}`;
  const passage =
    options.passage ||
    "Take a slow breath and notice the small sounds around you. The room can be calm without being silent: a kettle cooling, rain at the window, footsteps in another room. Keep a steady pace as you speak, leave a little space between each sentence, and finish this whole passage before you stop.";
  /* The benchmark measures the project's mounted voice capability. */
  using itx = (await connectProject(options)) as unknown as {
    voice: Pick<VoiceAgentRpc, "setupVoiceAgent">;
    [Symbol.dispose](): void;
  };
  await itx.voice.setupVoiceAgent({
    streamPath,
    instructions: options.instructions || "Speak the supplied commentary clearly and naturally.",
  });

  const call = await openWireCall({
    ...options,
    streamPath,
    micBatchFrames: MIC_APPEND_MS / 20,
    micEventFrames: MIC_APPEND_MS / 20,
  });
  let instructions: string;
  let streamResult: {
    setup: {
      callStartedAtMs: number | null;
      sessionConfiguredAtMs: number | null;
      acceptedAtMs: number | null;
      handshakeTookMs: number | null;
    };
    commentaryRequestedAtMs: number;
    firstResponseLocalMs: number;
    answers: ReturnType<typeof metricsByAnswer>;
    receiptToSendFacetMs: ReturnType<typeof percentiles>;
    postCommentaryFrames: AudioFrame[];
  };
  try {
    const publisher = await openStream({ ...options, streamPath });
    try {
      const ready = await call.waitFor(
        () =>
          call.watch.conversationAcceptedAtMs !== null &&
          call.watch.sessionConfiguredAtMs !== null &&
          Boolean(call.watch.sessionInstructions),
        30_000,
      );
      requireReady(ready, "stream session did not become ready with durable live instructions");
      await sleep(1_000);
      requireReady(
        !call.watch.spkArrivals.some((frame) => frame.hasSignal),
        "stream spoke before the controlled commentary",
      );
      instructions = call.watch.sessionInstructions!.text;
      requireReady(
        instructions.length < 8_000,
        "stream instructions reached the durable 8000-character cap; exact direct comparison is unavailable",
      );
      const commentaryRequestedAtMs = call.clock();
      await publisher.stream.append({
        type: "events.iterate.com/voice-agent/commentary",
        payload: { activation: call.watch.activation, delegationId: null, content: passage },
      });
      const spoke = await call.waitFor(
        () =>
          call.watch.spkArrivals.some(
            (frame) => frame.atMs >= commentaryRequestedAtMs && frame.hasSignal,
          ),
        45_000,
      );
      requireReady(spoke, "stream commentary produced no speaking PCM");
      const answerEnded = await call.waitFor(
        () => call.watch.answerEnds.some((answer) => answer.atMs >= commentaryRequestedAtMs),
        45_000,
      );
      requireReady(answerEnded, "stream commentary produced no lastFrameOfAnswer marker");
      const quiet = await call.waitFor(() => call.quietFor(3_000), 45_000);
      requireReady(quiet, "stream commentary never settled after its answer marker");
      requireReady(
        call.watch.providerErrors.length === 0 && call.watch.providerDisconnects.length === 0,
        "stream commentary emitted a provider diagnostic",
      );

      const frames = call.watch.spkArrivals
        .filter((frame) => frame.atMs >= commentaryRequestedAtMs)
        .map((frame) => ({
          atMs: frame.atMs,
          payloadMs: frame.payloadMs,
          hasSignal: frame.hasSignal,
          receivedAtFacetMs: frame.receivedAtFacetMs,
          sentAtFacetMs: frame.sentAtFacetMs,
          answerIndex: frame.answerIndex,
        }));
      const firstSignal = frames.find((frame) => frame.hasSignal)!;
      const receiptToSendMs = frames.flatMap((frame) =>
        frame.receivedAtFacetMs === null || frame.sentAtFacetMs === null
          ? []
          : [frame.sentAtFacetMs - frame.receivedAtFacetMs],
      );
      streamResult = {
        setup: {
          callStartedAtMs: call.watch.callStartedAtMs,
          sessionConfiguredAtMs: call.watch.sessionConfiguredAtMs,
          acceptedAtMs: call.watch.conversationAcceptedAtMs,
          handshakeTookMs: call.watch.handshakeTookMs,
        },
        commentaryRequestedAtMs,
        firstResponseLocalMs: firstSignal.atMs - commentaryRequestedAtMs,
        answers: metricsByAnswer(frames),
        receiptToSendFacetMs: percentiles(receiptToSendMs),
        postCommentaryFrames: frames,
      };
    } finally {
      publisher.close();
    }
  } finally {
    await call.stop("controlled direct-versus-stream comparison");
  }
  const direct = await liveProbe({
    rate: RATE,
    micAppendMs: MIC_APPEND_MS,
    instructions,
    fixedCommentary: passage,
    initialFrames: [],
    settleMs: 3_000,
    verbose: false,
    emitSummary: false,
  });
  requireReady(direct.errors.length === 0, "direct provider leg emitted a diagnostic");
  const directFrames = direct.outputFrames
    .filter((frame) => frame.arrivedAtMs >= direct.commentarySentAtMs!)
    .map((frame) => ({
      atMs: frame.arrivedAtMs,
      payloadMs: frame.audioMs,
      hasSignal: frame.hasSignal,
      answerIndex: frame.answerIndex,
    }));
  const directFirstSignal = directFrames.find((frame) => frame.hasSignal);
  if (!direct.commentarySentAtMs || !directFirstSignal) {
    throw new Error("direct provider leg produced no speaking PCM after commentary");
  }
  requireReady(
    !direct.outputFrames.some(
      (frame) => frame.arrivedAtMs < direct.commentarySentAtMs! && frame.hasSignal,
    ),
    "direct provider spoke before the controlled commentary",
  );
  const result = {
    streamPath,
    contract: {
      model: "gpt-live-1",
      rate: RATE,
      micAppendMs: MIC_APPEND_MS,
      voice: "marin",
      instructions,
      passage,
      input: "100ms zero PCM",
    },
    direct: {
      sessionStartedAtMs: direct.startedMs,
      commentarySentAtMs: direct.commentarySentAtMs,
      firstResponseLocalMs: directFirstSignal.atMs - direct.commentarySentAtMs,
      answers: metricsByAnswer(directFrames),
      postCommentaryFrames: directFrames,
    },
    stream: streamResult,
    clockBoundary:
      "Direct and stream first-response values use each leg's local Node observer. receiptToSendFacetMs uses only the voice facet clock; no result subtracts clocks across machines.",
  };
  console.log(JSON.stringify(result, null, 2));
}
