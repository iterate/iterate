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
import { MicSource, PlayoutBuffer, percentiles, BYTES_PER_SEC } from "./audio.ts";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { createImpairment, parseImpairSpec } from "./impair.ts";
import { openResilientConnection } from "./resilient.ts";

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
  /** Grok model for call-requested. */
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
}

export async function client(options: ClientOptions) {
  const streamPath = options.path ?? `/voicelab/call-${Date.now()}`;
  const framesPerAppend = options.framesPerAppend ?? 1;
  const turnsTarget = options.turns ?? (options.mic ? 0 : options.say2 ? 2 : 1);
  const callId = crypto.randomUUID().slice(0, 8);
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
  let micFramesSent = 0;
  let turnsDone = 0;
  let appendErrors = 0;
  let firstAppendError: string | undefined;
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

  const fireAppend = (...events: Parameters<typeof stream.append>) => {
    stream.append(...events).catch((error: unknown) => {
      appendErrors++;
      firstAppendError ??= error instanceof Error ? error.message : String(error);
    });
  };

  const connection = await openResilientConnection(stream, {
    connectionKey: `voicelab-client-${callId}`,
    eventTypes: [
      "voicelab/spk-frame",
      "voicelab/grok-event",
      "voicelab/pong",
      "voicelab/call-accepted",
    ],
    quietMs: 4000,
    onEvents: (events) => {
      impair.rx(() => {
        const now = Date.now();
        for (const event of events) {
          const payload = event.payload as Record<string, unknown>;
          switch (event.type) {
            case "voicelab/call-accepted":
              accepted = true;
              console.error(`client: call accepted by ${payload.bridge} bridge (${payload.model})`);
              break;
            case "voicelab/spk-frame": {
              spkFrames++;
              const pcm = Buffer.from(payload.pcm as string, "base64");
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
              spkOneWay.push(now - (payload.t as number));
              grokToClient.push(now - (payload.tGrok as number));
              playout.write(pcm);
              break;
            }
            case "voicelab/grok-event": {
              const grokEvent = payload.event as { type: string; [key: string]: unknown };
              handleGrokEvent(grokEvent, now);
              break;
            }
            case "voicelab/pong": {
              const t0 = payload.t0 as number;
              const t1 = payload.t1 as number;
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
        const item = event.item as
          | { role?: string; content?: { type?: string; transcript?: string }[] }
          | undefined;
        if (item?.role === "user") {
          const transcript = item.content?.find((c) => c.type === "input_audio")?.transcript;
          if (transcript) userTranscript = transcript;
        }
        break;
      }
      case "response.created":
        turnTranscript = "";
        break;
      case "response.output_audio_transcript.delta":
        turnTranscript += (event.delta as string) ?? "";
        assistantTranscript += (event.delta as string) ?? "";
        break;
      case "response.done": {
        turnsDone++;
        playout.endOfResponse();
        console.error(`client: turn ${turnsDone} done — "${turnTranscript.trim()}"`);
        if (turnsTarget > 0 && turnsDone >= turnsTarget && !finishRequested) {
          finishRequested = true;
          setTimeout(() => done?.(), Math.max(500, playout.depthMs() + 300));
        }
        break;
      }
    }
  };

  // Durable control-plane event opens the call; the bridge answers call-accepted.
  await stream.append({
    type: "voicelab/call-requested",
    payload: {
      callId,
      ...(options.model ? { model: options.model } : {}),
      ...(options.voice ? { voice: options.voice } : {}),
      effort: options.effort === "high" ? "high" : "none",
      bridge: options.workerUrl ? "worker" : "node",
    },
  });
  console.error(`client: call-requested on ${streamPath} (callId=${callId})`);

  // Worker-bridge mode: the anchor socket starts (and keeps alive) the
  // userspace VoiceBridge DO. It carries no audio.
  let anchor: WebSocket | null = null;
  let anchorPingTimer: NodeJS.Timeout | null = null;
  if (options.workerUrl) {
    const anchorUrl = new URL(options.workerUrl);
    anchorUrl.searchParams.set("mode", "bridge");
    anchorUrl.searchParams.set("path", streamPath);
    anchorUrl.searchParams.set("callId", callId);
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
    if (Date.now() > acceptDeadline) {
      throw new Error("No call-accepted within 20s — is a bridge running on this path?");
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
        type: "voicelab/mic-frame",
        ephemeral: true as const,
        payload: { callId, ...payload },
      }));
      pendingFrames = [];
      micFramesSent += events.length;
      impair.tx(() => fireAppend(...events));
    }
  });
  mic.start();

  const pingTimer = setInterval(() => {
    const payload = { id: crypto.randomUUID().slice(0, 8), t0: Date.now() };
    impair.tx(() => fireAppend({ type: "voicelab/ping", ephemeral: true, payload }));
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
  fireAppend({ type: "voicelab/call-ended", payload: { callId, reason: "client done" } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  anchor?.close();
  connection.close();

  const utteranceEnd = mic.utteranceEnds[0] ?? mic.utteranceEndAt;
  const summary = {
    role: "client",
    path: streamPath,
    callId,
    config: {
      framesPerAppend,
      effort: options.effort === "high" ? "high" : "none",
      synthetic: !options.mic,
      bridge: options.workerUrl ? "worker" : "node",
      ...(impair.describe === null ? {} : { impairment: impair.describe }),
    },
    micFramesSent,
    spkFrames,
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
    ...(firstAppendError === undefined ? {} : { firstAppendError }),
    userTranscript,
    assistantTranscript: assistantTranscript.trim(),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.appendErrors > 0 ? 2 : 0);
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
