// The voice client: streams mic PCM into a stream as ephemeral events and plays
// speaker PCM arriving on the same stream, with barge-in (playout cleared when the
// bridge forwards Grok's speech_started). Works headless with a synthetic utterance
// (--say / --pcm, deterministic, prints a latency summary) or live (--mic --device,
// space toggles push-to-talk mute, Ctrl+C for summary).
//
//   doppler run --config dev -- pnpm cli voicelab client --project prj_… --path /voicelab/call-1 --say "What is the capital of France?"
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path_ from "node:path";
import process from "node:process";
import WebSocket from "ws";
import type { DynamicWorkerCapability } from "iterate/sdk";
import { z } from "zod";
import { MicSource, PlayoutBuffer, percentiles, BYTES_PER_SEC, mulawToPcm16 } from "./audio.ts";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { createImpairment, parseImpairSpec } from "./impair.ts";
import { openResilientConnection } from "./resilient.ts";
import { discardRpcResult, RpcResultObserver, withRpcResult } from "./rpc-ownership.ts";
import { voiceAgentEntrypointRef } from "./voice-agent-ref.ts";

const CallAcceptedPayload = z.looseObject({ bridge: z.string(), model: z.string() });
const SpeakerFramePayload = z.looseObject({
  enc: z.literal("u").optional(),
  pcm: z.string(),
  seq: z.number().int().nonnegative(),
  t: z.number(),
  tGrok: z.number(),
});
const GrokEvent = z.looseObject({ type: z.string() });
const GrokEventPayload = z.looseObject({ event: GrokEvent });
const PongPayload = z.looseObject({ t0: z.number(), t1: z.number() });
const ConversationItem = z.looseObject({
  content: z
    .array(z.looseObject({ transcript: z.string().optional(), type: z.string().optional() }))
    .optional(),
  role: z.string().optional(),
});

/** Options for `pnpm cli voicelab client`. */
export interface ClientOptions extends VoicelabConnectOptions {
  /** Stream path for the call. Defaults to a fresh /voicelab/call-<ts>. */
  path?: string;
  /** Synthesize this utterance with macOS `say` and use it as the mic. */
  say?: string;
  /** Raw 16kHz mono PCM16 file to use as the mic. */
  pcm?: string;
  /** Use the real microphone (space toggles mute, q quits). */
  mic?: boolean;
  /** Play responses through the real speaker. */
  device?: boolean;
  /** Exit after this many completed responses (0 = run until Ctrl+C). */
  turns?: number;
  /** Grok model for conversation-requested. */
  model?: string;
  /** Grok voice. */
  voice?: string;
  /** Reasoning effort: none (fast) or high (thinking). */
  effort?: string;
  /** Mic frames coalesced per append call (1 = 20ms per append). */
  framesPerAppend?: number;
  /** Barge-in test: speak this second utterance while the first answer plays. */
  say2?: string;
  /** Delay from first answer audio to the barge-in utterance (ms). */
  say2AfterMs?: number;
  /** Simulated bad network at the client's transport touchpoints, e.g. "tx=40,rx=40,jitter=60,stallEveryMs=7000,stallMs=400". */
  impair?: string;
  /**
   * Worker-bridge mode: wss URL of the project's voice app
   * (wss://voice--<slug>.<base>/). Opens the anchor socket that starts the
   * userspace VoiceBridge DO instead of relying on a running node bridge.
   */
  workerUrl?: string;
  /**
   * Detached worker bridge: start the call with one `itx.worker.startCall`
   * over this same session and let it hold itself open. Nothing local stays
   * running for the call — no node bridge, no anchor socket. This is the
   * shape a device uses.
   */
  detached?: boolean;
  /** Line the assistant speaks as soon as the call is live (detached mode). */
  greet?: string;
  /** Alternate HTTP(S) realtime-provider base URL for a detached proof. */
  grokBaseUrl?: string;
  /** Soak mode: re-speak the same utterance after each answer until --turns is reached. */
  repeatSay?: boolean;
}

export async function client(options: ClientOptions) {
  const streamPath = options.path ?? `/voicelab/call-${Date.now()}`;
  const framesPerAppend = options.framesPerAppend ?? 1;
  const turnsTarget = options.turns ?? (options.mic ? 0 : options.say2 ? 2 : 1);
  const conversationId = crypto.randomUUID().slice(0, 8);
  const impair = createImpairment(parseImpairSpec(options.impair));
  if (impair.describe) console.error(`client: impairment ${impair.describe}`);

  let syntheticPcmPath = options.pcm;
  if (!options.mic && !syntheticPcmPath) {
    const text =
      options.say ?? "What is the capital of France? Please answer in one short sentence.";
    syntheticPcmPath = synthesizeUtterance(text);
  }
  // Pre-synthesize the barge-in utterance: `say` is slow and must not stall the call.
  const say2Pcm = options.say2 ? fs.readFileSync(synthesizeUtterance(options.say2)) : null;
  const repeatPcm =
    options.repeatSay && syntheticPcmPath ? fs.readFileSync(syntheticPcmPath) : null;

  using itx = await connectProject(options);
  using stream = itx.streams.get(streamPath);

  const playout = new PlayoutBuffer({ device: options.device === true });
  const mic = new MicSource(syntheticPcmPath ? { syntheticPcmPath } : {});

  const marks: Record<string, number> = {};
  const spkOneWay: number[] = [];
  const grokToClient: number[] = [];
  const rtts: number[] = [];
  const clockOffsets: number[] = [];
  let spkFrames = 0;
  let spkBytes = 0;
  let spkFramesLost = 0; // seq gaps = ephemeral frames appended while no connection was live
  let lastSpkSeq = -1;
  let micFramesSent = 0;
  let turnsDone = 0;
  let appendErrors = 0;
  let firstAppendError: string | undefined;
  let invalidEvents = 0;
  let firstInvalidEvent: string | undefined;
  let accepted = false;
  let userTranscript: string | null = null;
  let assistantTranscript = "";
  let turnTranscript = "";
  let finishRequested = false;
  let say2Injected = false;
  let bargeInAt: number | null = null;
  let bargeInReactionMs: number | null = null;
  const bargeInDrops: number[] = [];
  let done: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const rejectInvalidEvent = (type: string, detail: string) => {
    invalidEvents++;
    firstInvalidEvent ??= `${type}: ${detail}`;
    console.error(`client: invalid ${type} event: ${detail}`);
    done?.();
  };

  const appendResults = new RpcResultObserver((error: unknown) => {
    appendErrors++;
    firstAppendError ??= error instanceof Error ? error.message : String(error);
  });
  const fireAppend = (...events: Parameters<typeof stream.append>) => {
    appendResults.observe(stream.append(...events));
  };

  using connection = await openResilientConnection(stream, {
    connectionKey: `voicelab-client-${conversationId}`,
    eventTypes: [
      "events.iterate.com/voice-agent/spk-frame",
      "events.iterate.com/voice-agent/grok-event",
      "events.iterate.com/voice-agent/pong",
      "events.iterate.com/voice-agent/conversation-accepted",
    ],
    quietMs: 4000,
    // Before conversation-accepted there is legitimately no traffic; afterwards pings
    // guarantee a batch at least every 2s.
    trafficExpected: () => accepted,
    onEvents: (events) => {
      impair.rx(() => {
        const now = Date.now();
        for (const event of events) {
          switch (event.type) {
            case "events.iterate.com/voice-agent/conversation-accepted": {
              const payload = CallAcceptedPayload.safeParse(event.payload);
              if (!payload.success) {
                rejectInvalidEvent(event.type, payload.error.message);
                continue;
              }
              accepted = true;
              console.error(
                `client: call accepted by ${payload.data.bridge} bridge (${payload.data.model})`,
              );
              break;
            }
            case "events.iterate.com/voice-agent/spk-frame": {
              const payload = SpeakerFramePayload.safeParse(event.payload);
              if (!payload.success) {
                rejectInvalidEvent(event.type, payload.error.message);
                continue;
              }
              spkFrames++;
              const { seq } = payload.data;
              if (lastSpkSeq >= 0 && seq > lastSpkSeq + 1) spkFramesLost += seq - lastSpkSeq - 1;
              lastSpkSeq = Math.max(lastSpkSeq, seq);
              const encoded = Buffer.from(payload.data.pcm, "base64");
              const pcm = payload.data.enc === "u" ? mulawToPcm16(encoded) : encoded;
              spkBytes += pcm.length;
              if (marks.firstSpkFrame === undefined) {
                marks.firstSpkFrame = now;
                if (say2Pcm && !say2Injected) {
                  say2Injected = true;
                  setTimeout(() => {
                    bargeInAt = Date.now();
                    mic.inject(say2Pcm);
                    console.error("client: barge-in utterance injected");
                  }, options.say2AfterMs ?? 1200);
                }
              }
              spkOneWay.push(now - payload.data.t);
              grokToClient.push(now - payload.data.tGrok);
              playout.write(pcm);
              break;
            }
            case "events.iterate.com/voice-agent/grok-event": {
              const payload = GrokEventPayload.safeParse(event.payload);
              if (!payload.success) {
                rejectInvalidEvent(event.type, payload.error.message);
                continue;
              }
              handleGrokEvent(payload.data.event, now);
              break;
            }
            case "events.iterate.com/voice-agent/pong": {
              const payload = PongPayload.safeParse(event.payload);
              if (!payload.success) {
                rejectInvalidEvent(event.type, payload.error.message);
                continue;
              }
              const { t0, t1 } = payload.data;
              const rtt = now - t0;
              rtts.push(rtt);
              // NTP-style: assumes symmetric legs; good enough to de-skew one-way stats.
              clockOffsets.push(t1 - (t0 + rtt / 2));
              break;
            }
          }
        }
      });
    },
  });

  const handleGrokEvent = (event: { type: string; [key: string]: unknown }, now: number) => {
    switch (event.type) {
      case "input_audio_buffer.speech_started": {
        const dropped = playout.clear();
        if (dropped > 0) {
          bargeInDrops.push(Math.round(dropped));
          console.error(`client: barge-in, dropped ${Math.round(dropped)}ms of queued audio`);
        }
        if (bargeInAt !== null && bargeInReactionMs === null) {
          bargeInReactionMs = Math.round(now - bargeInAt);
        }
        break;
      }
      case "input_audio_buffer.speech_stopped":
        marks.speechStopped = now;
        break;
      case "conversation.item.input_audio_transcription.updated":
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string") userTranscript = event.transcript;
        break;
      case "conversation.item.added": {
        const item = ConversationItem.safeParse(event.item);
        if (!item.success) {
          rejectInvalidEvent(event.type, item.error.message);
          break;
        }
        if (item.data.role === "user") {
          const transcript = item.data.content?.find((c) => c.type === "input_audio")?.transcript;
          if (transcript) userTranscript = transcript;
        }
        break;
      }
      case "response.created":
        turnTranscript = "";
        break;
      case "response.output_audio_transcript.delta":
        if (typeof event.delta !== "string") {
          rejectInvalidEvent(event.type, "delta must be a string");
          break;
        }
        turnTranscript += event.delta;
        assistantTranscript += event.delta;
        break;
      case "response.done": {
        turnsDone++;
        playout.endOfResponse();
        console.error(`client: turn ${turnsDone} done — "${turnTranscript.trim()}"`);
        if (turnsTarget > 0 && turnsDone >= turnsTarget && !finishRequested) {
          finishRequested = true;
          setTimeout(() => done?.(), Math.max(500, playout.depthMs() + 300));
        } else if (options.repeatSay && repeatPcm && turnsDone < turnsTarget) {
          setTimeout(() => mic.inject(repeatPcm), Math.max(800, playout.depthMs() + 400));
        }
        break;
      }
    }
  };

  // Durable control-plane event opens the call; the bridge answers conversation-accepted.
  await discardRpcResult(
    stream.append({
      type: "events.iterate.com/voice-agent/conversation-requested",
      payload: {
        conversationId,
        ...(options.model ? { model: options.model } : {}),
        ...(options.voice ? { voice: options.voice } : {}),
        ...(options.grokBaseUrl ? { grokBaseUrl: options.grokBaseUrl } : {}),
        effort: options.effort === "high" ? "high" : "none",
        bridge: options.detached ? "worker-detached" : options.workerUrl ? "worker" : "node",
      },
    }),
  );
  console.error(
    `client: conversation-requested on ${streamPath} (conversationId=${conversationId})`,
  );

  // Detached mode: one RPC starts a call that outlives this process. The
  // only thing this client does afterwards is push mic frames and play what
  // comes back — exactly what the ESP32 does.
  if (options.detached) {
    // workers.get() is typed from the static config-repo template, which
    // cannot describe the runtime-installed guest at this exact ref. That
    // guest defines startCall, so this narrow capability is declared here.
    using worker = itx.workers.get(voiceAgentEntrypointRef) as unknown as DynamicWorkerCapability<{
      startCall(options: Record<string, unknown>): Promise<{
        ok?: boolean;
        reason?: string;
        startMs?: number;
      }>;
    }>;
    const started = await withRpcResult(
      worker.startCall({
        conversationId,
        effort: options.effort === "high" ? "high" : "none",
        path: streamPath,
        ...(options.greet ? { greet: options.greet } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.voice ? { voice: options.voice } : {}),
        ...(options.grokBaseUrl ? { grokBaseUrl: options.grokBaseUrl } : {}),
      }),
      ({ ok, reason, startMs }) => ({ ok, reason, startMs }),
    );
    if (started.ok !== true) {
      throw new Error(`worker.startCall refused: ${started.reason ?? JSON.stringify(started)}`);
    }
    console.error(`client: detached worker bridge live in ${started.startMs}ms`);
  }

  // Worker-bridge mode: the anchor socket starts (and keeps alive) the
  // userspace VoiceBridge DO. It carries no audio.
  let anchor: WebSocket | null = null;
  let anchorPingTimer: NodeJS.Timeout | null = null;
  if (options.workerUrl) {
    const anchorUrl = new URL(options.workerUrl);
    anchorUrl.searchParams.set("mode", "bridge");
    anchorUrl.searchParams.set("path", streamPath);
    anchorUrl.searchParams.set("conversationId", conversationId);
    anchorUrl.searchParams.set("effort", options.effort === "high" ? "high" : "none");
    if (options.model) anchorUrl.searchParams.set("model", options.model);
    if (options.voice) anchorUrl.searchParams.set("voice", options.voice);
    anchor = new WebSocket(anchorUrl.toString());
    anchor.on("open", () => console.error("client: worker anchor socket connected"));
    anchor.on("close", (code: number) => console.error(`client: worker anchor closed (${code})`));
    anchor.on("error", (error: Error) =>
      console.error(`client: worker anchor error: ${error.message}`),
    );
    anchorPingTimer = setInterval(() => {
      if (anchor?.readyState === WebSocket.OPEN) anchor.send("ka");
    }, 20_000);
  }

  const acceptDeadline = Date.now() + 20_000;
  while (!accepted) {
    if (invalidEvents > 0) {
      throw new Error(firstInvalidEvent ?? "invalid stream event before call acceptance");
    }
    if (Date.now() > acceptDeadline) {
      throw new Error("No conversation-accepted within 20s — is a bridge running on this path?");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Mic starts only once the call is accepted so Grok never misses utterance onset.
  let pendingFrames: { seq: number; t: number; pcm: string }[] = [];
  let micSeq = 0;
  mic.on("frame", (frame: Buffer) => {
    pendingFrames.push({ seq: micSeq++, t: Date.now(), pcm: frame.toString("base64") });
    if (pendingFrames.length >= framesPerAppend) {
      const events = pendingFrames.map((payload) => ({
        type: "events.iterate.com/voice-agent/mic-frame",
        ephemeral: true as const,
        payload: { conversationId, ...payload },
      }));
      pendingFrames = [];
      micFramesSent += events.length;
      impair.tx(() => fireAppend(...events));
    }
  });
  mic.start();

  const pingTimer = setInterval(() => {
    const payload = { id: crypto.randomUUID().slice(0, 8), t0: Date.now() };
    impair.tx(() =>
      fireAppend({ type: "events.iterate.com/voice-agent/ping", ephemeral: true, payload }),
    );
  }, 2000);

  if (options.mic) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (key: Buffer) => {
      const char = key.toString();
      if (char === " ") {
        mic.muted = !mic.muted;
        console.error(mic.muted ? "client: mic MUTED" : "client: mic LIVE");
      } else if (char === "q" || char === "") {
        done?.();
      }
    });
    console.error("client: mic LIVE — space toggles mute, q quits");
  }
  process.on("SIGINT", () => done?.());

  await finished;
  clearInterval(pingTimer);
  if (anchorPingTimer) clearInterval(anchorPingTimer);
  mic.stop();
  playout.stop();
  fireAppend({
    type: "events.iterate.com/voice-agent/conversation-ended",
    payload: { conversationId, reason: "client done" },
  });
  await appendResults.drain();
  anchor?.close();
  connection.close();

  const utteranceEnd = mic.utteranceEnds[0] ?? mic.utteranceEndAt;
  const summary = {
    role: "client",
    path: streamPath,
    conversationId,
    config: {
      framesPerAppend,
      effort: options.effort === "high" ? "high" : "none",
      synthetic: !options.mic,
      bridge: options.detached ? "worker-detached" : options.workerUrl ? "worker" : "node",
      ...(impair.describe === null ? {} : { impairment: impair.describe }),
    },
    micFramesSent,
    spkFrames,
    spkFramesLost,
    spkSeconds: +(spkBytes / BYTES_PER_SEC).toFixed(2),
    latency: {
      utteranceEndToFirstSpkFrameMs:
        utteranceEnd !== null && marks.firstSpkFrame !== undefined
          ? Math.round(marks.firstSpkFrame - performanceToWall(utteranceEnd))
          : null,
      spkOneWayMs: percentiles(spkOneWay),
      grokRecvToClientMs: percentiles(grokToClient),
      pingRttMs: percentiles(rtts),
      estimatedClockOffsetMs: percentiles(clockOffsets).p50 ?? null,
    },
    playout: playout.stats(),
    ...(bargeInAt === null
      ? {}
      : { bargeIn: { reactionMs: bargeInReactionMs, droppedMs: bargeInDrops } }),
    connection: connection.stats(),
    appendErrors,
    invalidEvents,
    ...(firstAppendError === undefined ? {} : { firstAppendError }),
    ...(firstInvalidEvent === undefined ? {} : { firstInvalidEvent }),
    userTranscript,
    assistantTranscript: assistantTranscript.trim(),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.appendErrors > 0 || summary.invalidEvents > 0) process.exitCode = 2;
  return summary;
}

/** Convert a performance.now() mark to wall-clock ms. */
function performanceToWall(performanceMs: number): number {
  return performance.timeOrigin + performanceMs;
}

/** Render text to raw 16kHz mono PCM16 via macOS `say` + sox. */
function synthesizeUtterance(text: string): string {
  const dir = fs.mkdtempSync(path_.join(os.tmpdir(), "voicelab-"));
  const aiff = path_.join(dir, "utterance.aiff");
  const pcm = path_.join(dir, "utterance.pcm");
  execFileSync("say", ["-v", "Samantha", "-o", aiff, text]);
  execFileSync("sox", [
    aiff,
    "-r",
    "16000",
    "-c",
    "1",
    "-b",
    "16",
    "-e",
    "signed-integer",
    "-t",
    "raw",
    pcm,
  ]);
  return pcm;
}
