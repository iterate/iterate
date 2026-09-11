import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { z } from "zod";
import { Pcm16Resampler } from "../../../../packages/voice-agent/src/pcm.ts";

const INPUT_RATE_HZ = 24_000;
const FIXTURE_RATE_HZ = 16_000;
const FRAME_MS = 20;
const FIXTURE_FRAME_BYTES = (FIXTURE_RATE_HZ * 2 * FRAME_MS) / 1000;
const ACTIVITY_WINDOW_MS = 10;
const ACTIVITY_WINDOW_SAMPLES = (INPUT_RATE_HZ * ACTIVITY_WINDOW_MS) / 1000;
const ACTIVITY_RMS_THRESHOLD = 150;
const DEFAULT_GAP_MS = 750;
const RESPONSE_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.voicelab-runs/latency-fixture/banana-satellite-capture.wav",
);
const DEFAULT_SESSION_SNAPSHOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.voicelab-runs/latency-fixture/provider-session.json",
);

export interface DirectOpenAiOptions {
  /** Processed Satellite1 16 kHz mono PCM16 WAV or raw `.pcm` fixture. */
  fixture?: string;
  /** Recorded `effectiveSessionUpdated` object used to configure the raw dial. */
  sessionSnapshot?: string;
  /** JSONL destination. Each completed turn is durable before the next begins. */
  outputPath?: string;
  /** Stop after this many turns. Omit when using `durationMs` alone. */
  turns?: number;
  /** Stop opening new turns after this elapsed duration. */
  durationMs?: number;
  /** Quiet gap between completed turns, in milliseconds. */
  gapMs?: number;
}

type JsonObject = Record<string, unknown>;

type DirectOpenAiTurn = {
  turn: number;
  startedMs: number;
  elapsedSinceFirstTurnMs: number;
  speechEndSentMs: number;
  providerSpeechStoppedMs: number | null;
  firstAudioReceivedMs: number | null;
  firstNonQuietAudioMs: number | null;
  responseDoneMs: number;
  speechEndToFirstAudioReceivedMs: number | null;
  speechEndToFirstNonQuietAudioMs: number | null;
  outputDeltas: number;
  outputBytes: number;
  responsesCreated: number;
  responsesDone: number;
  inputTranscriptsCompleted: number;
  outputTranscriptsCompleted: number;
  inputTranscript: string | null;
  outputTranscript: string | null;
};

const Model = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "model contains unsupported URL characters");
const RealtimeSession = z.looseObject({ model: Model });
const UplinkSnapshot = z.looseObject({
  effectiveSessionUpdated: z.array(z.looseObject({ session: RealtimeSession })).min(1),
});
const LatencyBoardSnapshot = z.looseObject({
  effectiveSessions: z.array(RealtimeSession).min(1),
});
const ProviderEvent = z.looseObject({ type: z.string() });
const ResponseCreated = z.looseObject({
  type: z.literal("response.created"),
  response: z.looseObject({ id: z.string() }),
});
const OutputAudioDelta = z.looseObject({
  type: z.literal("response.output_audio.delta"),
  response_id: z.string(),
  delta: z.string(),
});
const ResponseDone = z.looseObject({
  type: z.literal("response.done"),
  response: z.looseObject({ id: z.string() }),
});
const InputTranscript = z.looseObject({
  type: z.literal("conversation.item.input_audio_transcription.completed"),
  transcript: z.string(),
});
const OutputTranscript = z.looseObject({
  type: z.literal("response.output_audio_transcript.done"),
  response_id: z.string(),
  transcript: z.string(),
});

/** A one-connection OpenAI Realtime latency floor. No mic, speaker, or reconnect. */
export async function directOpenai(options: DirectOpenAiOptions = {}) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required; run through Doppler.");
  const fixturePath = options.fixture ?? DEFAULT_FIXTURE;
  const snapshotPath = options.sessionSnapshot ?? DEFAULT_SESSION_SNAPSHOT;
  const outputPath =
    options.outputPath ??
    path.join(
      ".voicelab-runs",
      `direct-openai-${new Date().toISOString().replaceAll(":", "-")}.jsonl`,
    );
  const turnsLimit =
    options.turns ?? (options.durationMs === undefined ? 3 : Number.POSITIVE_INFINITY);
  const durationMs = options.durationMs;
  const gapMs = options.gapMs ?? DEFAULT_GAP_MS;
  if (!Number.isInteger(turnsLimit) && turnsLimit !== Number.POSITIVE_INFINITY) {
    throw new Error("turns must be a positive integer.");
  }
  if (
    turnsLimit < 1 ||
    !Number.isFinite(gapMs) ||
    gapMs < 0 ||
    (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0))
  ) {
    throw new Error("turns, durationMs, and gapMs must be positive finite values.");
  }

  const fixture = decodeFixturePcm16(fixturePath);
  const snapshot = readSessionSnapshot(snapshotPath);
  const log = openJsonl(outputPath);
  const startedAtMs = performance.now();
  const deadlineMs = durationMs === undefined ? Number.POSITIVE_INFINITY : startedAtMs + durationMs;
  let socket: WebSocket | undefined;

  try {
    socket = await openSocket(apiKey, snapshot.model);
    const effectiveSession = await updateSession(socket, snapshot.session);
    const session = sessionReport(snapshot.session, effectiveSession);
    log.write({
      type: "started",
      fixture: fixtureReport(fixturePath, fixture),
      session,
      turnsLimit,
      durationMs,
      gapMs,
    });

    const turns: DirectOpenAiTurn[] = [];
    const pacer = new InputPacer(socket);
    while (turns.length < turnsLimit && performance.now() < deadlineMs) {
      if (turns.length > 0) await pacer.sendSilenceFor(gapMs);
      if (performance.now() >= deadlineMs) break;
      const turn = await runTurn(socket, pacer, fixture, turns.length, turns[0]?.startedMs ?? null);
      turns.push(turn);
      log.write({ type: "turn", ...turn });
    }
    if (turns.length === 0) throw new Error("duration elapsed before a turn could start.");
    const result = {
      type: "summary",
      provider: "openai",
      model: snapshot.model,
      fixture: fixtureReport(fixturePath, fixture),
      session,
      turns: turns.length,
      elapsedMs: round(performance.now() - startedAtMs),
      latencyMs: latencyReport(turns),
      drift: driftReport(turns),
      inputPacer: pacer.report(),
    };
    log.write(result);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.write({ type: "error", elapsedMs: round(performance.now() - startedAtMs), message });
    throw error;
  } finally {
    log.close();
    socket?.close();
  }
}

function openJsonl(outputPath: string) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const handle = fs.openSync(outputPath, "w");
  return {
    write(value: unknown) {
      fs.writeSync(handle, `${JSON.stringify(value)}\n`);
    },
    close() {
      fs.closeSync(handle);
    },
  };
}

/** Reads only the durable uplink capture or the canonical latency-board result. */
export function readSessionSnapshot(snapshotPath: string): { model: string; session: JsonObject } {
  const parsed: unknown = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const uplink = UplinkSnapshot.safeParse(parsed);
  const session = uplink.success
    ? structuredClone(uplink.data.effectiveSessionUpdated[0]!.session)
    : structuredClone(LatencyBoardSnapshot.parse(parsed).effectiveSessions[0]!);
  const model = Model.parse(session.model);
  delete session.object;
  delete session.id;
  delete session.expires_at;
  return { model, session: RealtimeSession.parse(withoutNulls(session)) };
}

/** `session.updated` reports unset fields as null; `session.update` rejects some nulls. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== null)
        .map(([key, nested]) => [key, withoutNulls(nested)]),
    );
  }
  return value;
}

function decodeFixturePcm16(sourcePath: string): Buffer {
  if (!fs.statSync(sourcePath).isFile()) throw new Error(`fixture is not a file: ${sourcePath}`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "voicelab-direct-openai-"));
  const output = path.join(directory, "fixture-16k.pcm");
  try {
    const rawInput = sourcePath.toLowerCase().endsWith(".pcm");
    execFileSync("sox", [
      ...(rawInput
        ? [
            "-t",
            "raw",
            "-r",
            String(FIXTURE_RATE_HZ),
            "-e",
            "signed-integer",
            "-b",
            "16",
            "-c",
            "1",
          ]
        : []),
      sourcePath,
      "-t",
      "raw",
      "-r",
      String(FIXTURE_RATE_HZ),
      "-e",
      "signed-integer",
      "-b",
      "16",
      "-c",
      "1",
      output,
    ]);
    const fixture = fs.readFileSync(output);
    if (fixture.length === 0 || fixture.length % 2 !== 0 || !hasActivity(fixture)) {
      throw new Error("fixture has no 10 ms RMS>=150 PCM16 activity window.");
    }
    return fixture;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function hasActivity(pcm: Buffer): boolean {
  const windowBytes = ACTIVITY_WINDOW_SAMPLES * 2;
  for (let offset = 0; offset + windowBytes <= pcm.length; offset += windowBytes) {
    let sumSquares = 0;
    for (let sampleOffset = offset; sampleOffset < offset + windowBytes; sampleOffset += 2) {
      const sample = pcm.readInt16LE(sampleOffset);
      sumSquares += sample * sample;
    }
    if (Math.sqrt(sumSquares / ACTIVITY_WINDOW_SAMPLES) >= ACTIVITY_RMS_THRESHOLD) return true;
  }
  return false;
}

/** Keeps the provider's input clock continuous without catching up in bursts. */
class InputPacer {
  readonly #resampler = new Pcm16Resampler(FIXTURE_RATE_HZ, INPUT_RATE_HZ);
  #nextDueMs = performance.now();
  #maxSchedulerLagMs = 0;
  #maxBufferedAmount = 0;

  constructor(readonly socket: WebSocket) {}

  async sendSourcePcm(source: Buffer): Promise<Buffer> {
    const pcm = Buffer.from(this.#resampler.push(source));
    const waitMs = this.#nextDueMs - performance.now();
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    const now = performance.now();
    this.#maxSchedulerLagMs = Math.max(this.#maxSchedulerLagMs, now - this.#nextDueMs);
    this.socket.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }),
    );
    this.#maxBufferedAmount = Math.max(this.#maxBufferedAmount, this.socket.bufferedAmount);
    this.#nextDueMs += FRAME_MS;
    /* If a scheduler pause passed the next deadline, restart cadence from now;
     * emitting several frames back-to-back would hide the delay. */
    if (this.#nextDueMs < now) this.#nextDueMs = now + FRAME_MS;
    return pcm;
  }

  async sendSilenceFor(milliseconds: number) {
    const silence = Buffer.alloc(FIXTURE_FRAME_BYTES);
    for (let elapsed = 0; elapsed < milliseconds; elapsed += FRAME_MS) {
      await this.sendSourcePcm(silence);
    }
  }

  report() {
    return {
      maxSchedulerLagMs: round(this.#maxSchedulerLagMs),
      maxBufferedAmount: this.#maxBufferedAmount,
    };
  }
}

async function openSocket(apiKey: string, model: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        perMessageDeflate: false,
      },
    );
    const timeout = setTimeout(
      () => done(new Error(`OpenAI socket did not open within ${CONNECT_TIMEOUT_MS} ms.`)),
      CONNECT_TIMEOUT_MS,
    );
    const onError = (error: Error) => done(error);
    const done = (error?: Error) => {
      clearTimeout(timeout);
      socket.off("error", onError);
      if (error) {
        socket.close();
        reject(error);
      } else resolve(socket);
    };
    socket.once("error", onError);
    socket.once("open", () => {
      done();
    });
  });
}

async function updateSession(socket: WebSocket, session: JsonObject): Promise<JsonObject> {
  return waitForEvent(socket, "session.updated", RESPONSE_TIMEOUT_MS, () => {
    socket.send(JSON.stringify({ type: "session.update", session }));
  }).then((event) => {
    if (!isJsonObject(event.session))
      throw new Error("session.updated omitted its session object.");
    return event.session;
  });
}

export async function runTurn(
  socket: WebSocket,
  pacer: InputPacer,
  fixture: Buffer,
  index: number,
  firstTurnStartedMs: number | null,
): Promise<DirectOpenAiTurn> {
  const startedMs = performance.now();
  let speechEndSentMs: number | null = null;
  let providerSpeechStoppedMs: number | null = null;
  let firstAudioReceivedMs: number | null = null;
  let firstNonQuietAudioMs: number | null = null;
  let responseDoneMs: number | null = null;
  let outputDeltas = 0;
  let outputBytes = 0;
  let outputTail = Buffer.alloc(0);
  let responsesCreated = 0;
  let responsesDone = 0;
  let inputTranscriptsCompleted = 0;
  let outputTranscriptsCompleted = 0;
  let inputTranscript: string | null = null;
  let outputTranscript: string | null = null;
  let senderFinished = false;
  let responseFinished = false;
  let responseId: string | null = null;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => done(new Error(`turn ${index + 1} timed out after ${RESPONSE_TIMEOUT_MS} ms.`)),
      RESPONSE_TIMEOUT_MS,
    );
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const finishIfReady = () => {
      if (
        senderFinished &&
        responseFinished &&
        inputTranscript !== null &&
        outputTranscript !== null
      )
        done();
    };
    const onClose = (code: number, reason: Buffer) =>
      done(new Error(`OpenAI socket closed mid-run (${code} ${reason.toString("utf8")}).`));
    const onMessage = (raw: WebSocket.RawData) => {
      let event: JsonObject;
      try {
        event = parseProviderEvent(raw);
      } catch (error) {
        return done(error instanceof Error ? error : new Error(String(error)));
      }
      if (event.type === "error")
        return done(new Error(`OpenAI error: ${JSON.stringify(event.error ?? event)}`));
      const now = performance.now();
      if (event.type === "input_audio_buffer.speech_stopped") providerSpeechStoppedMs = now;
      if (event.type === "response.created") {
        if (responseId !== null)
          return done(new Error(`turn ${index + 1} received more than one response.created.`));
        responseId = ResponseCreated.parse(event).response.id;
        responsesCreated++;
      }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        inputTranscript = InputTranscript.parse(event).transcript;
        inputTranscriptsCompleted++;
        if (!containsBanana(inputTranscript)) {
          return done(new Error(`turn ${index + 1} did not transcribe the banana fixture.`));
        }
        finishIfReady();
      }
      if (event.type === "response.output_audio_transcript.done") {
        const transcript = OutputTranscript.parse(event);
        if (responseId === null || transcript.response_id !== responseId) return;
        outputTranscript = transcript.transcript;
        outputTranscriptsCompleted++;
        if (!containsBanana(outputTranscript)) {
          return done(new Error(`turn ${index + 1} did not answer banana to the banana fixture.`));
        }
        finishIfReady();
      }
      if (event.type === "response.output_audio.delta") {
        const delta = OutputAudioDelta.parse(event);
        if (responseId === null || delta.response_id !== responseId) return;
        const pcm = Buffer.from(delta.delta, "base64");
        /* Empty deltas precede PCM on some responses; they are not audio arrival. */
        if (pcm.length === 0) return;
        outputDeltas++;
        outputBytes += pcm.length;
        if (firstAudioReceivedMs === null) firstAudioReceivedMs = now;
        outputTail = Buffer.concat([outputTail, pcm]);
        const completeBytes =
          Math.floor(outputTail.length / (ACTIVITY_WINDOW_SAMPLES * 2)) *
          ACTIVITY_WINDOW_SAMPLES *
          2;
        if (firstNonQuietAudioMs === null && hasActivity(outputTail.subarray(0, completeBytes))) {
          firstNonQuietAudioMs = now;
        }
        outputTail = Buffer.from(outputTail.subarray(completeBytes));
      }
      if (event.type === "response.done") {
        const completed = ResponseDone.parse(event);
        if (responseId === null || completed.response.id !== responseId) return;
        responsesDone++;
        responseDoneMs = now;
        if (firstAudioReceivedMs === null || firstNonQuietAudioMs === null) {
          return done(new Error(`turn ${index + 1} completed without non-quiet output audio.`));
        }
        if (responsesCreated !== 1 || responsesDone !== 1) {
          return done(
            new Error(
              `turn ${index + 1} response event accounting was not one created and one done.`,
            ),
          );
        }
        responseFinished = true;
        finishIfReady();
      }
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    void (async () => {
      try {
        for (let offset = 0; offset < fixture.length; offset += FIXTURE_FRAME_BYTES) {
          if (settled) return;
          const pcm = fixture.subarray(
            offset,
            Math.min(offset + FIXTURE_FRAME_BYTES, fixture.length),
          );
          const sent = await pacer.sendSourcePcm(pcm);
          if (hasActivity(sent)) speechEndSentMs = performance.now();
        }
        const silence = Buffer.alloc(FIXTURE_FRAME_BYTES);
        while (!responseFinished || inputTranscript === null || outputTranscript === null) {
          if (settled) return;
          await pacer.sendSourcePcm(silence);
        }
        if (speechEndSentMs === null)
          throw new Error(`turn ${index + 1} sent no active fixture audio.`);
        senderFinished = true;
        finishIfReady();
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });

  if (speechEndSentMs === null || responseDoneMs === null)
    throw new Error(`turn ${index + 1} ended without required timestamps.`);
  return {
    turn: index + 1,
    startedMs: round(startedMs),
    elapsedSinceFirstTurnMs: round(startedMs - (firstTurnStartedMs ?? startedMs)),
    speechEndSentMs: round(speechEndSentMs),
    providerSpeechStoppedMs:
      providerSpeechStoppedMs === null ? null : round(providerSpeechStoppedMs),
    firstAudioReceivedMs: firstAudioReceivedMs === null ? null : round(firstAudioReceivedMs),
    firstNonQuietAudioMs: firstNonQuietAudioMs === null ? null : round(firstNonQuietAudioMs),
    responseDoneMs: round(responseDoneMs),
    speechEndToFirstAudioReceivedMs: span(speechEndSentMs, firstAudioReceivedMs),
    speechEndToFirstNonQuietAudioMs: span(speechEndSentMs, firstNonQuietAudioMs),
    outputDeltas,
    outputBytes,
    responsesCreated,
    responsesDone,
    inputTranscriptsCompleted,
    outputTranscriptsCompleted,
    inputTranscript,
    outputTranscript,
  };
}

function containsBanana(transcript: string) {
  return /\bbananas?\b/i.test(transcript);
}

function waitForEvent(
  socket: WebSocket,
  type: string,
  timeoutMs: number,
  send: () => void,
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => done(new Error(`timed out waiting for ${type}.`)), timeoutMs);
    const onClose = (code: number, reason: Buffer) =>
      done(
        new Error(`OpenAI socket closed waiting for ${type} (${code} ${reason.toString("utf8")}).`),
      );
    const onMessage = (raw: WebSocket.RawData) => {
      let event: JsonObject;
      try {
        event = parseProviderEvent(raw);
      } catch (error) {
        return done(error instanceof Error ? error : new Error(String(error)));
      }
      if (event.type === "error")
        return done(new Error(`OpenAI error: ${JSON.stringify(event.error ?? event)}`));
      if (event.type === type) done(undefined, event);
    };
    const done = (error?: Error, result?: JsonObject) => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(result!);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    send();
  });
}

function parseProviderEvent(raw: WebSocket.RawData): JsonObject {
  const parsed: unknown = JSON.parse(Buffer.from(raw as Buffer).toString("utf8"));
  return ProviderEvent.parse(parsed);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sessionReport(requested: JsonObject, effective: JsonObject) {
  const audio = isJsonObject(effective.audio) ? effective.audio : {};
  const input = isJsonObject(audio.input) ? audio.input : {};
  const output = isJsonObject(audio.output) ? audio.output : {};
  return {
    requestedConfigFingerprint: sessionConfigFingerprint(requested),
    effectiveConfigFingerprint: sessionConfigFingerprint(effective),
    requestedInstructionsFingerprint: instructionsFingerprint(requested),
    effectiveInstructionsFingerprint: instructionsFingerprint(effective),
    tools: Array.isArray(effective.tools) ? effective.tools.length : 0,
    inputRate: isJsonObject(input.format) ? input.format.rate : null,
    outputRate: isJsonObject(output.format) ? output.format.rate : null,
    voice: output.voice ?? null,
    vad: input.turn_detection ?? null,
    noiseReduction: input.noise_reduction ?? null,
  };
}

export function sessionConfigFingerprint(session: JsonObject) {
  const copy = structuredClone(session);
  delete copy.instructions;
  delete copy.object;
  delete copy.id;
  delete copy.expires_at;
  return createHash("sha256").update(stableJson(copy)).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function instructionsFingerprint(session: JsonObject) {
  return typeof session.instructions === "string"
    ? createHash("sha256").update(session.instructions).digest("hex").slice(0, 16)
    : null;
}

function fixtureReport(sourcePath: string, fixture: Buffer) {
  return {
    path: sourcePath,
    sourceRate: FIXTURE_RATE_HZ,
    inputRate: INPUT_RATE_HZ,
    bytes: fixture.length,
    sha256: createHash("sha256").update(fixture).digest("hex"),
    activityBoundary: { windowMs: ACTIVITY_WINDOW_MS, rmsThreshold: ACTIVITY_RMS_THRESHOLD },
  };
}

function latencyReport(turns: readonly DirectOpenAiTurn[]) {
  return {
    speechEndToFirstAudioReceived: statistics(
      turns.map((turn) => turn.speechEndToFirstAudioReceivedMs),
    ),
    speechEndToFirstNonQuietAudio: statistics(
      turns.map((turn) => turn.speechEndToFirstNonQuietAudioMs),
    ),
  };
}

function driftReport(turns: readonly DirectOpenAiTurn[]) {
  const values = turns
    .map((turn) => turn.speechEndToFirstNonQuietAudioMs)
    .filter((value): value is number => value !== null);
  const third = Math.ceil(values.length / 3);
  const firstThird = values.slice(0, third);
  const lastThird = values.slice(-third);
  return {
    firstThirdMedianMs: median(firstThird),
    lastThirdMedianMs: median(lastThird),
    lastMinusFirstThirdMedianMs:
      median(lastThird) === null || median(firstThird) === null
        ? null
        : round(median(lastThird)! - median(firstThird)!),
    slopeMsPerTurn: regressionSlope(values),
    slopeMsPerMinute: regressionSlope(
      values,
      turns.map((turn) => turn.elapsedSinceFirstTurnMs / 60_000),
    ),
    perTurn: turns.map((turn) => ({
      turn: turn.turn,
      elapsedSinceFirstTurnMs: turn.elapsedSinceFirstTurnMs,
      speechEndToFirstNonQuietAudioMs: turn.speechEndToFirstNonQuietAudioMs,
    })),
  };
}

function statistics(values: readonly (number | null)[]) {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return { n: 0 };
  const sorted = [...present].sort((left, right) => left - right);
  return {
    n: sorted.length,
    min: round(sorted[0]!),
    p50: median(sorted),
    p90: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!),
    p99: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!),
    max: round(sorted.at(-1)!),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function median(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.floor(sorted.length / 2)]!);
}

function regressionSlope(values: readonly number[], xs?: readonly number[]) {
  if (values.length < 2) return null;
  const coordinates = xs ?? values.map((_, index) => index);
  const meanX = coordinates.reduce((sum, value) => sum + value, 0) / coordinates.length;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index++) {
    const x = coordinates[index]! - meanX;
    numerator += x * (values[index]! - meanY);
    denominator += x * x;
  }
  return denominator === 0 ? null : round(numerator / denominator);
}

function span(from: number, to: number | null) {
  return to === null ? null : round(to - from);
}

function round(value: number) {
  return Number(value.toFixed(1));
}
