// A small synthetic client for the GPT-Live voice stream. It owns one local
// activation and observes only the public call contract.
import type { StreamEvent } from "iterate/sdk";

import { type VoicelabConnectOptions } from "./connect.ts";
import {
  deliveredMsOf,
  FRAME_BYTES,
  FRAME_MS,
  openStream,
  sleep,
  type StreamHandle,
} from "./probe-audio.ts";
import { closeAndDisposeRpcHandle, RpcResultObserver } from "./rpc-ownership.ts";

const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES).toString("base64");

export interface TimedText {
  atMs: number;
  text: string;
}

export interface WireWatch {
  activation: string;
  conversationId: string | null;
  callStartedAtMs: number | null;
  sessionConfiguredAtMs: number | null;
  conversationAcceptedAtMs: number | null;
  handshakeTookMs: number | null;
  heldMicFrames: number | null;
  spkFrames: number;
  answersEnded: number;
  answerDeliveredMs: number;
  lastAudioFrameAtMs: number | null;
  clearsSeen: number;
  utterances: TimedText[];
  answers: TimedText[];
  instructions: TimedText[];
  thinking: TimedText[];
  commentary: TimedText[];
  providerErrors: TimedText[];
  providerDisconnects: TimedText[];
  ended: TimedText[];
  spkArrivals: {
    atMs: number;
    payloadMs: number;
    batchAudioFrames: number;
    sentAtFacetMs: number | null;
    answerIndex: number;
  }[];
  micAppendLatenciesMs: number[];
}

export interface WireCall {
  readonly streamPath: string;
  readonly watch: WireWatch;
  clock(): number;
  speak(frames: string[]): Promise<void>;
  micFramesSent(): number;
  waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean>;
  quietFor(quietMs: number): boolean;
  stop(reason?: string): Promise<void>;
  durableEvents(): Promise<StreamEvent[]>;
}

interface VoiceStreamReads {
  getEvents(input: {
    afterOffset: number;
    eventTypes?: string[];
    limit: number;
  }): Promise<StreamEvent[]>;
}

export async function openWireCall(
  options: VoicelabConnectOptions & {
    streamPath: string;
    micBatchFrames?: number;
    micEventFrames?: number;
    micOffBetweenUtterances?: boolean;
    noiseEventsPerAppend?: number;
    keepaliveEventsPerAppend?: number;
  },
): Promise<WireCall> {
  const micBatchFrames = options.micBatchFrames ?? 3;
  const micEventFrames = Math.max(1, options.micEventFrames ?? micBatchFrames);
  const openedStream = await openStream(options);
  const { stream } = openedStream;
  const startedAtMs = Date.now();
  const clock = () => Date.now() - startedAtMs;
  const activation = crypto.randomUUID();
  const watch: WireWatch = {
    activation,
    conversationId: null,
    callStartedAtMs: null,
    sessionConfiguredAtMs: null,
    conversationAcceptedAtMs: null,
    handshakeTookMs: null,
    heldMicFrames: null,
    spkFrames: 0,
    answersEnded: 0,
    answerDeliveredMs: 0,
    lastAudioFrameAtMs: null,
    clearsSeen: 0,
    utterances: [],
    answers: [],
    instructions: [],
    thinking: [],
    commentary: [],
    providerErrors: [],
    providerDisconnects: [],
    ended: [],
    spkArrivals: [],
    micAppendLatenciesMs: [],
  };

  const belongsToCall = (payload: Record<string, unknown>) =>
    payload.activation === activation ||
    (watch.conversationId && payload.conversationId === watch.conversationId);
  const text = (payload: Record<string, unknown>) =>
    typeof payload.text === "string" ? payload.text : "";
  const content = (payload: Record<string, unknown>) =>
    typeof payload.content === "string" ? payload.content : "";

  let connection: Awaited<ReturnType<StreamHandle["openConnection"]>>;
  try {
    connection = await stream.openConnection({
      connectionKey: `wire-call-${activation}`,
      eventTypes: [
        "events.iterate.com/voice-agent/spk-frame",
        "events.iterate.com/voice-agent/call-started",
        "events.iterate.com/voice-agent/conversation-accepted",
        "events.iterate.com/voice-agent/session-configured",
        "events.iterate.com/voice-agent/utterance-transcript",
        "events.iterate.com/voice-agent/answer-transcript",
        "events.iterate.com/voice-agent/instructions",
        "events.iterate.com/voice-agent/thinking",
        "events.iterate.com/voice-agent/commentary",
        "events.iterate.com/voice-agent/provider-error",
        "events.iterate.com/voice-agent/provider-disconnected",
        "events.iterate.com/voice-agent/conversation-ended",
      ],
      processEventBatch: (batch: { events?: { type: string; payload?: unknown }[] }) => {
        const events = batch.events || [];
        /* `spk-frame` is the selected event whose contract carries `pcm`.
         * Stream batches are untyped at this boundary, so these small casts
         * express only the field being measured; the runtime checks exclude a
         * malformed payload rather than trusting it as parsed voice data. */
        const batchAudioFrames = events.filter(
          (event) =>
            event.type === "events.iterate.com/voice-agent/spk-frame" &&
            typeof (event.payload as { pcm?: unknown } | undefined)?.pcm === "string" &&
            (event.payload as { pcm: string }).pcm !== "",
        ).length;
        for (const event of events) {
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          if (event.type === "events.iterate.com/voice-agent/call-started") {
            if (payload.activation !== activation || typeof payload.conversationId !== "string")
              continue;
            watch.conversationId = payload.conversationId;
            watch.callStartedAtMs = clock();
            continue;
          }
          if (!belongsToCall(payload)) continue;
          if (event.type === "events.iterate.com/voice-agent/conversation-accepted") {
            watch.conversationAcceptedAtMs = clock();
            watch.handshakeTookMs =
              typeof payload.handshakeTookMs === "number" ? payload.handshakeTookMs : null;
            watch.heldMicFrames =
              typeof payload.heldMicFrames === "number" ? payload.heldMicFrames : null;
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/session-configured") {
            watch.sessionConfiguredAtMs = clock();
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/utterance-transcript") {
            watch.utterances.push({ atMs: clock(), text: text(payload) });
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/answer-transcript") {
            watch.answers.push({ atMs: clock(), text: text(payload) });
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/instructions") {
            watch.instructions.push({ atMs: clock(), text: content(payload) });
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/thinking") {
            watch.thinking.push({ atMs: clock(), text: content(payload) });
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/commentary") {
            watch.commentary.push({ atMs: clock(), text: content(payload) });
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/provider-error") {
            watch.providerErrors.push({
              atMs: clock(),
              text: text(payload) || String(payload.message ?? ""),
            });
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/provider-disconnected") {
            watch.providerDisconnects.push({
              atMs: clock(),
              text: text(payload) || String(payload.reason ?? ""),
            });
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/conversation-ended") {
            watch.ended.push({ atMs: clock(), text: String(payload.reason ?? "") });
            continue;
          }
          if (event.type !== "events.iterate.com/voice-agent/spk-frame") continue;
          watch.spkFrames += 1;
          const pcm = typeof payload.pcm === "string" ? payload.pcm : "";
          if (payload.clearSpeakerBufferBeforeFrame === true && pcm === "") watch.clearsSeen += 1;
          if (payload.lastFrameOfAnswer === true) watch.answersEnded += 1;
          if (pcm === "") continue;
          watch.answerDeliveredMs += deliveredMsOf(pcm);
          watch.lastAudioFrameAtMs = clock();
          watch.spkArrivals.push({
            atMs: clock(),
            payloadMs: deliveredMsOf(pcm),
            batchAudioFrames,
            sentAtFacetMs: typeof payload.sentAtFacetMs === "number" ? payload.sentAtFacetMs : null,
            answerIndex: watch.answersEnded,
          });
        }
      },
    });
  } catch (error) {
    openedStream.close();
    throw error;
  }

  const pending: Array<string | symbol> = [];
  const micAppendErrors: unknown[] = [];
  const micAppends = new RpcResultObserver((error) => micAppendErrors.push(error));
  let micFramesSent = 0;
  let stopMic = false;
  let stopped = false;
  const micLoop = (async () => {
    const startedAt = Date.now();
    let sequence = 0;
    while (!stopMic) {
      const due = startedAt + (sequence + micBatchFrames) * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      if (options.micOffBetweenUtterances === true && pending.length === 0 && sequence > 0) {
        sequence += micBatchFrames;
        continue;
      }
      const events = [];
      for (let index = 0; index < micBatchFrames; index += micEventFrames) {
        const count = Math.min(micEventFrames, micBatchFrames - index);
        const frames = Array.from({ length: count }, () => {
          const frame = pending.shift();
          return typeof frame === "string" && frame !== "" ? frame : SILENCE_FRAME;
        });
        const pcm =
          frames.length === 1
            ? frames[0]!
            : Buffer.concat(frames.map((frame) => Buffer.from(frame, "base64"))).toString("base64");
        events.push({
          type: "events.iterate.com/voice-agent/mic-frame" as const,
          ephemeral: true as const,
          payload: { activation, pcm },
        });
      }
      for (let index = 0; index < (options.keepaliveEventsPerAppend ?? 0); index++) {
        events.push({
          type: "events.iterate.com/voice-agent/keepalive" as const,
          ephemeral: true as const,
          payload: {},
        });
      }
      for (let index = 0; index < (options.noiseEventsPerAppend ?? 0); index++) {
        events.push({
          type: "events.iterate.com/voicelab/noise" as const,
          ephemeral: true as const,
          payload: { pcm: SILENCE_FRAME },
        });
      }
      sequence += micBatchFrames;
      micFramesSent += micBatchFrames;
      const appendStartedAtMs = Date.now();
      micAppends.observe(stream.append(...events), () => {
        watch.micAppendLatenciesMs.push(Date.now() - appendStartedAtMs);
      });
    }
  })();

  const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
    const until = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < until) await sleep(100);
    return predicate();
  };

  return {
    streamPath: options.streamPath,
    watch,
    clock,
    speak: (frames) =>
      new Promise<void>((resolve) => {
        const marker = Symbol("utterance-end");
        pending.push(...frames, marker);
        const check = setInterval(() => {
          if (!pending.includes(marker)) {
            clearInterval(check);
            resolve();
          }
        }, 20);
      }),
    micFramesSent: () => micFramesSent,
    waitFor,
    quietFor: (quietMs) =>
      watch.lastAudioFrameAtMs !== null && clock() - watch.lastAudioFrameAtMs > quietMs,
    stop: async (reason = "script-complete") => {
      if (stopped) return;
      stopped = true;
      try {
        stopMic = true;
        await micLoop;
        await micAppends.drain();
        const micAppendError = micAppendErrors[0];
        if (watch.ended.length === 0) {
          await stream.append({
            type: "events.iterate.com/voice-agent/conversation-ended" as const,
            payload: { activation, reason },
          });
        }
        if (micAppendError !== undefined) throw micAppendError;
      } finally {
        closeAndDisposeRpcHandle(connection);
        openedStream.close();
      }
    },
    durableEvents: async () => {
      const openedReadStream = await openStream(options);
      try {
        const readable = openedReadStream.stream as unknown as VoiceStreamReads;
        const eventTypes = [
          "events.iterate.com/voice-agent/call-started",
          "events.iterate.com/voice-agent/conversation-accepted",
          "events.iterate.com/voice-agent/session-configured",
          "events.iterate.com/voice-agent/utterance-transcript",
          "events.iterate.com/voice-agent/answer-transcript",
          "events.iterate.com/voice-agent/instructions",
          "events.iterate.com/voice-agent/thinking",
          "events.iterate.com/voice-agent/commentary",
          "events.iterate.com/voice-agent/provider-error",
          "events.iterate.com/voice-agent/provider-disconnected",
          "events.iterate.com/voice-agent/conversation-ended",
        ];
        const events: StreamEvent[] = [];
        let afterOffset = 0;
        for (;;) {
          const page = await readable.getEvents({ afterOffset, eventTypes, limit: 500 });
          events.push(...page);
          if (page.length < 500) break;
          afterOffset = page.at(-1)!.offset;
        }
        return events.filter((event) => {
          const payload = (event.payload || {}) as Record<string, unknown>;
          return (
            payload.activation === activation || payload.conversationId === watch.conversationId
          );
        });
      } finally {
        openedReadStream.close();
      }
    },
  };
}
