import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import { connectProject, deviceCapability, type VoicelabConnectOptions } from "./connect.ts";

const say = promisify(execFile);
const HealthRecord = z.looseObject({ conversation: z.string().min(1) });
const ProviderEvent = z.record(z.string(), z.unknown());
const SessionConfigured = z.looseObject({ greeting: z.boolean() });
const ProviderEnvelope = z.looseObject({ event: ProviderEvent.optional() });
const ConnectionHealth = z.object({
  uptimeMs: z.number().int().nonnegative(),
  sessionGeneration: z.number().int().nonnegative(),
  connGeneration: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(),
});

/** Account for the firmware's callback renewal without mistaking it for a new WebSocket. */
export function classifyBoardConnectionChange(before: unknown, after: unknown) {
  const from = ConnectionHealth.parse(before);
  const to = ConnectionHealth.parse(after);
  if (to.uptimeMs < from.uptimeMs || to.sessionGeneration !== from.sessionGeneration)
    return "transport-restart";
  if (to.connGeneration === from.connGeneration) return "unchanged";
  // voicelab_stream.h renews after 600 batches; voice_loop.c forces it by 850.
  // The provider session and WebSocket persist across this callback replacement.
  if (to.connGeneration === from.connGeneration + 1 && from.batches >= 600)
    return "delivery-budget-refresh";
  return "unexpected-delivery-refresh";
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function withTimeout<T>(name: string, operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface LatencyBoardOptions extends VoicelabConnectOptions {
  /** Device capability name, such as satellite1. */
  board: string;
  /** Fixed utterance audio to play with afplay instead of the standard spoken probe. */
  utterance?: string;
  /** Optional turn limit. By default, keep repeating for the requested duration. */
  turns?: number;
  /** Run duration cap; defaults to ten minutes. */
  minutes?: number;
  /** Quiet time between turns. */
  gapMs?: number;
  /** Health sample interval; this is an observer bound, never an acoustic measurement. */
  pollMs?: number;
  /** Maximum allowed difference between first- and last-third median observer latency. */
  maxMedianDriftMs?: number;
  /** Conservative speech-end to observed playback budget; defaults to 3000 ms. */
  maxResponseLatencyMs?: number;
  /** Optional JSON evidence path. */
  out?: string;
}

type BoardCapability = {
  health(): Promise<Record<string, unknown>>;
  conversation: { end(): Promise<void> };
};

type Health = Record<string, unknown>;
type Turn = {
  turn: number;
  pass?: boolean;
  sayCompletedAt?: number;
  answerTranscript?: string;
  inputTranscripts?: string[];
  runtimeFailureDeltas?: Record<string, number>;
  audioDone?: number;
  responsesCreated?: number;
  responsesDone?: number;
  providerErrors?: number;
  toolCalls?: number;
  responseDoneAndDrained?: boolean;
  noRuntimeFailures?: boolean;
  noUnexpectedSupersession?: boolean;
  noStarvation?: boolean;
  oneInputTurn?: boolean;
  inputTranscriptMatchesPrompt?: boolean;
  bananaAnswerCount?: number;
  sameCall?: boolean;
  sameSession?: boolean;
  oneProviderSession?: boolean;
  responseWithinBudget?: boolean;
  sayEndToFirstBoardObservation?: {
    upperBoundMs: number;
    samplingIntervalMs: number;
    firstSampleAfterSay: boolean;
    label: string;
  };
  [key: string]: unknown;
};
type Result = {
  board: string;
  requestedTurns: number;
  pollMs: number;
  maxResponseLatencyMs: number;
  startedAt: string;
  verdict: "PASS" | "FAIL";
  turns: Turn[];
  events: { at: number; phase: string; type: string; payload: Record<string, unknown> }[];
  samples: Array<Health & { at: number; phase: string; turn?: number | string }>;
  errors: string[];
  metrics: Record<string, string>;
  providerSessionIds?: string[];
  passedLatencyAndAec?: boolean;
  returnedIdle?: boolean;
  drift?: ReturnType<typeof summarizeDrift>;
  before?: Health;
  callBaseline?: Health;
  sessionConfigured?: Health;
  elapsedRunMs?: number;
  effectiveSessions: Record<string, unknown>[];
  deliveryConnectionChanges: {
    at: number;
    from: z.infer<typeof ConnectionHealth>;
    to: z.infer<typeof ConnectionHealth>;
  }[];
};

export async function latencyBoard(options: LatencyBoardOptions) {
  const board = options.board;
  const turns = options.turns ?? 10_000;
  const minutes = options.minutes ?? 10;
  const gapMs = options.gapMs ?? 500;
  const pollMs = options.pollMs ?? 50;
  const maxMedianDriftMs = options.maxMedianDriftMs ?? 250;
  const maxResponseLatencyMs = options.maxResponseLatencyMs ?? 3_000;
  if (!Number.isInteger(turns) || turns < 1 || turns > 10_000)
    throw new Error("turns must be an integer from 1 through 10000");
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 30)
    throw new Error("minutes must be greater than zero and at most 30");
  if (!Number.isFinite(gapMs) || gapMs < 0 || gapMs > 30_000)
    throw new Error("gapMs must be between zero and 30000");
  if (!Number.isInteger(pollMs) || pollMs < 50 || pollMs > 250)
    throw new Error("pollMs must be an integer from 50 through 250");
  if (!Number.isFinite(maxMedianDriftMs) || maxMedianDriftMs < 0)
    throw new Error("maxMedianDriftMs must be non-negative");
  if (!Number.isFinite(maxResponseLatencyMs) || maxResponseLatencyMs <= 0)
    throw new Error("maxResponseLatencyMs must be greater than zero");
  using itx = await connectProject(options);
  const kit = deviceCapability<BoardCapability>(itx, board);
  const providerSessionIds = new Set<string>();
  const result: Result = {
    board,
    requestedTurns: turns,
    pollMs,
    maxResponseLatencyMs,
    startedAt: new Date().toISOString(),
    verdict: "FAIL",
    turns: [],
    events: [],
    samples: [],
    errors: [],
    effectiveSessions: [],
    deliveryConnectionChanges: [],
    metrics: {
      primaryAcousticMetric:
        "Measure room speech-end to board reply-onset from the continuous Mac microphone recording run alongside this proof; board health timing is a separately-labelled sampled upper bound.",
      hostBoardMetric:
        "provider speech-stopped observer receipt to first observed spkPlayed advance; actual advance is in the preceding polling interval.",
    },
  };
  let phase = "idle";
  let wakeRequested = false;
  let connection: { close(): Promise<void> } | undefined;
  let sessionConfigured: Record<string, unknown> | undefined;
  let measuringCall = false;

  function save() {
    if (options.out !== undefined) writeFileSync(options.out, JSON.stringify(result, null, 2));
  }
  function fail(message: string) {
    result.errors.push(message);
  }
  function flag(h: Record<string, unknown>, name: string) {
    if (h[name] === true || h[name] === 1) return true;
    if (h[name] === false || h[name] === 0) return false;
    throw new Error(`health() must report ${name} as a boolean`);
  }
  function counter(h: Record<string, unknown>, name: string) {
    const value = h[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error(`health() must report ${name} as a non-negative integer`);
    return value;
  }
  async function health(turn?: number | string): Promise<Record<string, unknown>> {
    const h = HealthRecord.parse(await withTimeout("health", kit.health(), 8_000));
    const previous = result.samples.at(-1);
    result.samples.push({ at: Date.now(), phase, turn, ...h });
    if (measuringCall && previous) {
      const change = classifyBoardConnectionChange(previous, h);
      if (change === "delivery-budget-refresh") {
        result.deliveryConnectionChanges.push({
          at: Date.now(),
          from: ConnectionHealth.parse(previous),
          to: ConnectionHealth.parse(h),
        });
      } else if (change !== "unchanged") {
        throw new Error(`board connection changed during the call: ${change}`);
      }
    }
    return h;
  }
  async function healthUntil(
    deadline: number,
    turn?: number | string,
  ): Promise<Record<string, unknown>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("health deadline elapsed");
    return await withTimeout("health", health(turn), Math.min(8_000, remaining));
  }

  function providerSessionId(payload: Record<string, unknown>): string | undefined {
    const session = payload.session;
    if (!isRecord(session)) return undefined;
    return typeof session.id === "string" ? session.id : undefined;
  }
  function providerEvidence(payload: Record<string, unknown>) {
    ProviderEvent.parse(payload);
    const type = String(payload.type ?? "unknown");
    const row: Record<string, unknown> = { type };
    for (const key of [
      "event_id",
      "response_id",
      "item_id",
      "output_index",
      "content_index",
      "receivedAtFacetMs",
      "audio_start_ms",
      "audio_end_ms",
    ]) {
      if (typeof payload[key] === "string" || Number.isSafeInteger(payload[key]))
        row[key] = payload[key];
    }
    if (payload.response && typeof payload.response === "object") {
      const response = payload.response as Record<string, unknown>;
      if (typeof response.id === "string") row.response_id ??= response.id;
      if (typeof response.status === "string") row.response_status = response.status;
    }
    if (type === "response.output_audio.delta")
      row.deltaBytes = Number.isSafeInteger(payload.deltaBytes) ? payload.deltaBytes : undefined;
    if (type === "response.output_audio_transcript.delta")
      row.delta = String(payload.delta ?? "").slice(0, 256);
    if (
      type.endsWith("input_audio_transcription.completed") ||
      type.endsWith("output_audio_transcript.done")
    )
      row.transcript = String(payload.transcript ?? "").slice(0, 512);
    if (type === "error") row.error = String(payload.error ?? "provider error").slice(0, 512);
    return row;
  }
  function deltas(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    names: string[],
  ) {
    return Object.fromEntries(
      names.map((name) => [name, counter(after, name) - counter(before, name)]),
    );
  }
  const runtimeCounterNames = [
    "frameFailures",
    "micDropped",
    "micProcessFailures",
    "aecBridgeFailures",
    "aecBridgeResetFailures",
    "aecSeqDiscontinuities",
    "aecClockRegressions",
    "aecEgressCopyFailures",
    "spkOverflow",
    "spkWriteFailures",
    "spkBadFrames",
    "spkDecodeFailures",
    "spkSeqGaps",
    "spkSeqMissing",
    "spkSeqRegressions",
    "codecCaptureOverruns",
    "codecCaptureFailures",
    "codecPlaybackFailures",
    "playbackQueueOverflows",
    "captureQueueOverflows",
    "inboxDiscarded",
    "outboxDiscarded",
    "protoFailures",
    "recvFailures",
    "sendFailures",
  ];
  function eventTimes(
    events: Array<{ at: number; payload: Record<string, unknown> }>,
    type: string,
  ) {
    return events.filter((event) => event.payload.type === type).map((event) => event.at);
  }
  function inputTranscripts(events: Array<{ payload: Record<string, unknown> }>) {
    return events
      .filter((event) => String(event.payload.type).endsWith("input_audio_transcription.completed"))
      .map((event) => String(event.payload.transcript ?? ""));
  }
  async function settleGreeting(active: Record<string, unknown>) {
    phase = "greeting";
    let previous: Record<string, unknown> = active;
    let heardGreeting = flag(active, "speakerPlaying") || counter(active, "spkWrites") > 0;
    let quietAt = 0;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const h = await healthUntil(deadline, 0);
      if (flag(h, "speakerPlaying") || counter(h, "spkWrites") > counter(previous, "spkWrites")) {
        heardGreeting = true;
        quietAt = 0;
      } else if (
        sessionConfigured &&
        ((sessionConfigured as Record<string, unknown>).greeting === false || heardGreeting)
      ) {
        quietAt ||= Date.now();
        if (Date.now() - quietAt >= 2_000) return h;
      }
      previous = h;
      await sleep(250);
    }
    throw new Error("greeting did not drain before latency turns");
  }
  async function runTurn(turn: number, prompt: string, callBaseline: Record<string, unknown>) {
    phase = `turn-${turn}-baseline`;
    const baseline = await health(turn);
    const baselineObservedAt = Date.now();
    const eventBaseline = result.events.length;
    const startedAt = Date.now();
    const observation: Turn = {
      turn,
      prompt,
      startedAt,
      baseline,
      baselineObservedAt,
      eventBaseline,
      pollMs,
    };
    phase = `turn-${turn}-say`;
    observation.sayStartedAt = Date.now();
    await playProbe(prompt);
    observation.sayCompletedAt = Date.now();
    phase = `turn-${turn}-observe`;
    const deadline = Date.now() + 45_000;
    let previous: Record<string, unknown> = baseline;
    let previousMeasuredAt = baselineObservedAt;
    let firstSampleAfterSay = true;
    let firstSpkPlayed;
    let responseDoneAt = 0;
    let quietAt = 0;
    while (Date.now() < deadline) {
      const healthRequestStartedAt = Date.now();
      const h = await healthUntil(deadline, turn);
      const observedAt = Date.now();
      const events = result.events.slice(eventBaseline);
      if (!responseDoneAt && events.some((event) => event.payload.type === "response.done"))
        responseDoneAt = observedAt;
      const advanced = counter(h, "spkPlayed") > counter(previous, "spkPlayed");
      if (!firstSpkPlayed && advanced) {
        firstSpkPlayed = {
          observedAt,
          healthRequestStartedAt,
          previousMeasuredAt,
          samplingIntervalMs: observedAt - previousMeasuredAt,
          firstSampleAfterSay,
          spkPlayedBefore: counter(previous, "spkPlayed"),
          spkPlayedObserved: counter(h, "spkPlayed"),
        };
      }
      if (responseDoneAt && firstSpkPlayed && !flag(h, "speakerPlaying") && !advanced) {
        quietAt ||= observedAt;
        if (observedAt - quietAt >= 1_000 && inputTranscripts(events).length > 0) {
          previous = h;
          break;
        }
      } else if (advanced || flag(h, "speakerPlaying")) {
        quietAt = 0;
      }
      previousMeasuredAt = observedAt;
      firstSampleAfterSay = false;
      previous = h;
      await sleep(pollMs);
    }
    const after = await health(turn);
    const events = result.events.slice(eventBaseline);
    const speechStarted = eventTimes(events, "input_audio_buffer.speech_started");
    const speechStopped = eventTimes(events, "input_audio_buffer.speech_stopped");
    const responseCreated = eventTimes(events, "response.created");
    const firstAudioDelta = eventTimes(events, "response.output_audio.delta")[0];
    observation.completedAt = Date.now();
    observation.providerObserverReceipt = {
      speechStarted,
      speechStopped,
      responseCreated,
      firstAudioDelta,
      responseDone: eventTimes(events, "response.done"),
    };
    observation.firstSpkPlayed = firstSpkPlayed;
    observation.sayEndToFirstBoardObservation = !firstSpkPlayed
      ? undefined
      : {
          upperBoundMs: firstSpkPlayed.observedAt - observation.sayCompletedAt,
          samplingIntervalMs: firstSpkPlayed.samplingIntervalMs,
          firstSampleAfterSay: firstSpkPlayed.firstSampleAfterSay,
          label: "Host board-observation upper bound; it is not an acoustic measurement.",
        };
    observation.providerToBoardObserverCorrelation =
      speechStopped[0] === undefined || !firstSpkPlayed
        ? undefined
        : {
            elapsedMs: firstSpkPlayed.observedAt - speechStopped[0],
            label:
              "Observer receipt correlation only; provider receipt time is not acoustic speech-end.",
          };
    observation.responseWithinBudget =
      observation.sayEndToFirstBoardObservation !== undefined &&
      observation.sayEndToFirstBoardObservation.upperBoundMs <= maxResponseLatencyMs;
    observation.responseDoneAndDrained =
      responseDoneAt !== 0 && quietAt !== 0 && Date.now() - quietAt >= 1_000;
    observation.inputTranscripts = inputTranscripts(events);
    observation.answerTranscript = events
      .filter((event) => event.payload.type === "response.output_audio_transcript.delta")
      .map((event) => String(event.payload.delta ?? ""))
      .join("");
    observation.bananaAnswerCount = (
      observation.answerTranscript.match(/\bbanana\b/gi) ?? []
    ).length;
    observation.responsesCreated = responseCreated.length;
    observation.responsesDone = eventTimes(events, "response.done").length;
    observation.audioDone = eventTimes(events, "response.output_audio.done").length;
    observation.providerErrors = eventTimes(events, "error").length;
    observation.toolCalls = eventTimes(events, "response.function_call_arguments.done").length;
    observation.runtimeFailureDeltas = deltas(baseline, after, runtimeCounterNames);
    observation.noRuntimeFailures = Object.values(observation.runtimeFailureDeltas).every(
      (value) => value === 0,
    );
    observation.noUnexpectedSupersession =
      counter(after, "spkSupersededMidplay") === counter(baseline, "spkSupersededMidplay");
    observation.noStarvation = counter(after, "spkStarvedMs") === counter(baseline, "spkStarvedMs");
    const inputTurn = classifyInputTurn({
      transcripts: observation.inputTranscripts,
      speechStarts: speechStarted.length,
      speechStops: speechStopped.length,
    });
    observation.oneInputTurn = inputTurn.oneInputTurn;
    observation.inputTranscriptMatchesPrompt = inputTurn.transcriptMatchesPrompt;
    observation.sameCall =
      flag(after, "callActive") &&
      flag(after, "wantsCall") &&
      after.conversation === callBaseline.conversation;
    observation.oneProviderSession = providerSessionIds.size === 1;
    observation.sameSession =
      counter(after, "sessionGeneration") === counter(callBaseline, "sessionGeneration") &&
      counter(after, "uptimeMs") >= counter(callBaseline, "uptimeMs");
    const measurementPass =
      Boolean(firstSpkPlayed) &&
      firstAudioDelta !== undefined &&
      observation.responsesCreated === 1 &&
      observation.responsesDone === 1 &&
      observation.audioDone >= 1 &&
      observation.providerErrors === 0 &&
      observation.toolCalls === 0 &&
      observation.responseDoneAndDrained &&
      observation.noRuntimeFailures &&
      observation.noUnexpectedSupersession &&
      observation.noStarvation &&
      observation.oneInputTurn &&
      observation.sameCall &&
      observation.sameSession &&
      observation.oneProviderSession;
    observation.pass = measurementPass && observation.bananaAnswerCount === 1;
    result.turns.push(observation);
    save();
    if (!measurementPass) throw new Error(`turn ${turn} did not meet latency/AEC acceptance`);
  }
  async function verifyHangup(before: Record<string, unknown>) {
    phase = "hangup";
    await withTimeout("conversation.end", kit.conversation.end(), 8_000);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const h = await healthUntil(deadline, "hangup");
      if (
        !flag(h, "callActive") &&
        !flag(h, "callPending") &&
        !flag(h, "wantsCall") &&
        counter(h, "uptimeMs") >= counter(before, "uptimeMs")
      ) {
        result.returnedIdle = true;
        return;
      }
      await sleep(250);
    }
    throw new Error("hangup did not return the board to idle");
  }
  try {
    const before = await health();
    result.before = before;
    if (flag(before, "callActive") || flag(before, "callPending") || flag(before, "wantsCall"))
      throw new Error("Call must start idle");
    using stream = itx.streams.get(HealthRecord.parse(before).conversation);
    connection = await stream.openConnection({
      connectionKey: `latency-proof-${board}-${Date.now()}`,
      eventTypes: [
        "events.iterate.com/voice-agent/grok-event",
        "events.iterate.com/voice-agent/session-configured",
      ],
      processEventBatch: (batch) => {
        for (const event of batch.events ?? []) {
          if (event.type === "events.iterate.com/voice-agent/session-configured") {
            sessionConfigured = SessionConfigured.parse(event.payload);
            result.sessionConfigured = sessionConfigured;
            continue;
          }
          const outer = ProviderEnvelope.parse(event.payload);
          const provider = outer.event ?? outer;
          if (provider.type === "session.updated") {
            result.effectiveSessions.push(ProviderEvent.parse(provider.session));
          }
          const providerSessionIdValue = providerSessionId(provider);
          if (providerSessionIdValue !== undefined) providerSessionIds.add(providerSessionIdValue);
          result.providerSessionIds = [...providerSessionIds];
          result.events.push({
            at: Date.now(),
            phase,
            type: event.type,
            payload: providerEvidence(provider),
          });
        }
      },
    });
    const wakeBefore = counter(before, "wakeWordDetections");
    phase = "wake";
    wakeRequested = true;
    await say("say", ["-r", "170", "Jarvis."], { timeout: 10_000 });
    const wakeDeadline = Date.now() + 45_000;
    let active;
    while (Date.now() < wakeDeadline) {
      const h = await healthUntil(wakeDeadline, "wake");
      if (flag(h, "callActive") && counter(h, "wakeWordDetections") > wakeBefore) {
        active = h;
        break;
      }
      await sleep(250);
    }
    if (!active) throw new Error("wake did not establish an active call");
    const callBaseline = await settleGreeting(active);
    if (!sessionConfigured || typeof sessionConfigured.greeting !== "boolean")
      throw new Error("call did not report greeting policy before greeting settled");
    result.callBaseline = callBaseline;
    measuringCall = true;
    const runStartedAt = Date.now();
    const deadlineAt = runStartedAt + minutes * 60_000;
    for (let turn = 1; turn <= turns && Date.now() < deadlineAt; turn++) {
      await runTurn(turn, "Please say banana.", callBaseline);
      await sleep(gapMs);
    }
    result.elapsedRunMs = Date.now() - runStartedAt;
    const incorrectAnswers = result.turns.filter((turn) => turn.bananaAnswerCount !== 1);
    if (incorrectAnswers.length > 0)
      fail(
        `Unexpected answer content: ${incorrectAnswers.map((turn) => `turn ${turn.turn}: ${JSON.stringify(turn.answerTranscript)}`).join(", ")}`,
      );
    const lateTurns = result.turns.filter((turn) => !turn.responseWithinBudget);
    if (lateTurns.length > 0)
      fail(
        `${lateTurns.length} turn(s) did not prove playback within ${maxResponseLatencyMs}ms: ` +
          lateTurns.map((turn) => turn.turn).join(", ") +
          ". Inspect the acoustic recording; observer timing is an upper bound.",
      );
    result.passedLatencyAndAec =
      result.turns.length > 0 &&
      result.turns.every((turn) => turn.pass === true && turn.responseWithinBudget === true);
    result.drift = summarizeDrift(result.turns, maxMedianDriftMs);
    if (!result.drift.pass) fail(result.drift.reason);
  } catch (error) {
    fail(String(error));
  } finally {
    if (wakeRequested) {
      try {
        await verifyHangup(result.callBaseline ?? result.before ?? (await health()));
      } catch (error) {
        fail(`hangup verification: ${error}`);
      }
    }
    if (connection) {
      try {
        await withTimeout("stream connection close", connection.close(), 8_000);
      } catch (error) {
        fail(`stream close: ${error}`);
      }
    }
    result.verdict =
      result.passedLatencyAndAec && result.returnedIdle && result.errors.length === 0
        ? "PASS"
        : "FAIL";
    if (result.verdict === "FAIL") process.exitCode = 1;
    save();
  }
  return {
    board,
    verdict: result.verdict,
    turns: result.turns.length,
    drift: result.drift,
    out: options.out,
    errors: result.errors,
  };

  async function playProbe(prompt: string) {
    if (options.utterance !== undefined) {
      await say("afplay", [options.utterance], { timeout: 20_000 });
      return;
    }
    await say("say", ["-r", "170", prompt], { timeout: 20_000 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)];
}
export function classifyInputTurn(input: {
  transcripts: string[];
  speechStarts: number;
  speechStops: number;
}) {
  const transcriptMatchesPrompt =
    input.transcripts.length === 1 && /\bbanana\b/i.test(input.transcripts[0]);
  return {
    // A different transcription of the same spoken turn is not evidence of
    // another voice input. Count VAD boundaries and completed transcripts;
    // the caller separately requires the correct answer and no interruption.
    oneInputTurn:
      input.transcripts.length === 1 && input.speechStarts === 1 && input.speechStops === 1,
    transcriptMatchesPrompt,
  };
}

export function summarizeDrift(
  turns: Array<{ sayEndToFirstBoardObservation?: { upperBoundMs: number } }>,
  maxMedianDriftMs: number,
) {
  const values = turns
    .map((turn) => turn.sayEndToFirstBoardObservation?.upperBoundMs)
    .filter((value): value is number => value !== undefined);
  const third = Math.floor(values.length / 3);
  if (third === 0)
    return {
      pass: false,
      reason: "Fewer than three observer samples; cannot assess drift.",
      endpointUncertainty: "Health polling observes an interval, not acoustic reply onset.",
    };
  const first = median(values.slice(0, third));
  const last = median(values.slice(-third));
  const driftMs = last! - first!;
  return {
    firstThirdMedianMs: first,
    lastThirdMedianMs: last,
    driftMs,
    maxMedianDriftMs,
    pass: driftMs <= maxMedianDriftMs,
    reason:
      driftMs <= maxMedianDriftMs
        ? "Observer median drift within acceptance."
        : `Observer median drift ${driftMs}ms exceeds ${maxMedianDriftMs}ms.`,
    endpointUncertainty:
      "First spkPlayed is seen only on the next bounded health sample; this is not an acoustic latency claim.",
  };
}
