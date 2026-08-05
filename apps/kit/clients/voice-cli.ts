// The TypeScript voice client: a plain stream participant, shaped like the
// C firmware (phase 5 of consolidation-plan.md).
//
// Same single Cap'n Web /api socket, same events: 50 Hz ephemeral
// voice-agent/mic-frame appends (mu-law + base64, decision D4), a resilient
// openConnection delivering voice-agent/spk-frame (mu-law decoded, classified
// by (call, answer, frame) identity exactly as the firmware's playout module
// does) plus grok-events, turn markers around push-to-talk, and one
// itx.workers startCall against the project's own voice agent. Authenticates
// as the PROJECT (project-secret) — the same credential a physical device
// carries in its provisioning blob — with an admin-secret fallback for lab
// use under a Doppler config.
//
//   pnpm --dir apps/kit voice -- --base-url http://localhost:5173 \
//     --project voice-test --say "What is the capital of France?"
import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { z } from "zod";
import type { DynamicWorkerCapability, StatelessDynamicWorkerRef } from "iterate/sdk";
import { connectItxReady } from "iterate/node";
import {
  BYTES_PER_SEC,
  FRAME_MS,
  MicSource,
  PlayoutBuffer,
  synthesizeUtterance,
} from "./audio-io.ts";
import { mulawToPcm16, pcm16ToMulaw } from "./mulaw.ts";
import { PlayoutClassifier } from "./playout-classifier.ts";
import { openResilientConnection } from "./resilient.ts";
import { discardRpcResult, RpcResultObserver, withRpcResult } from "./rpc-ownership.ts";

/*
 * The same wire schemas the firmware validates in C. `enc: "u"` marks mu-law;
 * `answer`/`frame` are the sender's account of which answer a frame belongs
 * to and where in it — identity, not timing.
 */
const SpeakerFramePayload = z.looseObject({
  answer: z.number().int().nonnegative().optional(),
  enc: z.literal("u").optional(),
  frame: z.number().int().nonnegative().optional(),
  pcm: z.string(),
  seq: z.number().int().nonnegative(),
  t: z.number(),
});
const GrokEventPayload = z.looseObject({
  event: z.looseObject({ type: z.string() }),
});
const CallAcceptedPayload = z.looseObject({ bridge: z.string() });

/*
 * The guest that owns startCall/setupVoiceAgent, addressed exactly as the C
 * firmware addresses it (see VOICE_AGENT_WORKER_REF in voicelab_stream.c).
 */
const voiceAgentRef = {
  path: "/",
  source: {
    createWorker: {
      entryPoint: "voice-agent.ts",
      files: { repoPath: "/repos/config", type: "repo" },
    },
  },
  type: "stateless",
} satisfies StatelessDynamicWorkerRef;

export interface VoiceCliOptions {
  baseUrl: string;
  project: string;
  /** The project's own API key (device-shaped auth). */
  projectApiKey?: string;
  /** Lab fallback: an OS admin secret (Doppler's APP_CONFIG_ADMIN_API_SECRET). */
  adminSecret?: string;
  /** Stream path; defaults to a fresh conversation, like a device call. */
  path?: string;
  /** Speak this text (macOS say) as the microphone. */
  say?: string;
  /** Raw 16 kHz mono PCM16 file to use as the microphone. */
  pcm?: string;
  /** Use the real microphone (space toggles talking, q quits). */
  mic?: boolean;
  /** Play answers through the real speaker. */
  device?: boolean;
  /** Exit after this many completed answers (0 = until Ctrl+C). */
  turns?: number;
  /** Mic frames coalesced per append (the device profile's value is 4). */
  framesPerAppend?: number;
  /** Line the assistant speaks as soon as the call is live. */
  greet?: string;
  /** Alternate realtime-provider base URL (the loopback fake, for hermetic runs). */
  grokBaseUrl?: string;
  /** Retain the summary as JSON. */
  out?: string;
}

interface VoiceAgentWorker {
  startCall(options: Record<string, unknown>): Promise<{ ok?: boolean; reason?: string }>;
}

export async function voiceCli(options: VoiceCliOptions) {
  const streamPath =
    options.path ?? `/agents/voice/${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
  const framesPerAppend = options.framesPerAppend ?? 4;
  const turnsTarget = options.turns ?? (options.mic ? 0 : 1);
  const callId = crypto.randomUUID().slice(0, 8);

  let syntheticPcmPath = options.pcm;
  if (!options.mic && !syntheticPcmPath) {
    syntheticPcmPath = synthesizeUtterance(
      options.say ?? "What is the capital of France? Please answer in one short sentence.",
    );
  }

  const auth = options.projectApiKey
    ? ({
        type: "project-secret",
        projectId: options.project,
        secret: options.projectApiKey,
      } as const)
    : options.adminSecret
      ? ({ type: "admin-secret", secret: options.adminSecret } as const)
      : undefined;
  if (!auth) {
    throw new Error(
      "No credential: pass --project-api-key (device-shaped) or set APP_CONFIG_ADMIN_API_SECRET.",
    );
  }
  using itx = await connectItxReady({
    auth,
    baseUrl: options.baseUrl,
    projectId: options.project,
  });
  using stream = itx.streams.get(streamPath);

  const playout = new PlayoutBuffer({ device: options.device === true });
  const classifier = new PlayoutClassifier(1);
  const mic = new MicSource(syntheticPcmPath ? { syntheticPcmPath } : {});

  let accepted = false;
  let talking = false;
  let turnsDone = 0;
  let spkFrames = 0;
  let spkBytes = 0;
  let micFramesSent = 0;
  let invalidEvents = 0;
  let appendErrors = 0;
  let firstError: string | undefined;
  let bargeIns = 0;
  let userTranscript: string | null = null;
  let assistantTranscript = "";
  let turnTranscript = "";
  let finishRequested = false;
  let done: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const appendResults = new RpcResultObserver((error: unknown) => {
    appendErrors++;
    firstError ??= error instanceof Error ? error.message : String(error);
  });
  const fireAppend = (...events: Parameters<typeof stream.append>) => {
    appendResults.observe(stream.append(...events));
  };

  const handleGrokEvent = (event: { type: string; [key: string]: unknown }) => {
    switch (event.type) {
      case "input_audio_buffer.speech_started": {
        /* Barge-in: a local act, no round trip — exactly like the device. */
        const droppedMs = playout.clear();
        classifier.interrupt();
        if (droppedMs > 0) bargeIns++;
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string") userTranscript = event.transcript;
        break;
      case "response.created":
        turnTranscript = "";
        break;
      case "response.output_audio_transcript.delta":
        if (typeof event.delta === "string") {
          turnTranscript += event.delta;
          assistantTranscript += event.delta;
        }
        break;
      case "response.done": {
        turnsDone++;
        playout.endOfResponse();
        classifier.markDrained();
        console.error(`voice: turn ${turnsDone} done — "${turnTranscript.trim()}"`);
        if (turnsTarget > 0 && turnsDone >= turnsTarget && !finishRequested) {
          finishRequested = true;
          setTimeout(() => done?.(), Math.max(500, playout.depthMs() + 300));
        }
        break;
      }
    }
  };

  using connection = await openResilientConnection(stream, {
    connectionKey: `kit-voice-${callId}`,
    eventTypes: [
      "voice-agent/spk-frame",
      "voice-agent/grok-event",
      "voice-agent/pong",
      "voice-agent/call-accepted",
    ],
    quietMs: 4000,
    trafficExpected: () => accepted,
    onEvents: (events) => {
      for (const event of events) {
        switch (event.type) {
          case "voice-agent/call-accepted": {
            const payload = CallAcceptedPayload.safeParse(event.payload);
            if (!payload.success) {
              invalidEvents++;
              continue;
            }
            accepted = true;
            console.error(`voice: call accepted by ${payload.data.bridge} bridge`);
            break;
          }
          case "voice-agent/spk-frame": {
            const payload = SpeakerFramePayload.safeParse(event.payload);
            if (!payload.success) {
              invalidEvents++;
              firstError ??= payload.error.message;
              continue;
            }
            /*
             * Identity exactly as the firmware reads it: `call` is the local
             * epoch, a missing `frame` falls back to the call-wide sequence.
             */
            const action = classifier.classify({
              call: 1,
              answer: payload.data.answer ?? 0,
              frame: payload.data.frame ?? payload.data.seq,
            });
            if (action === "ignore") continue;
            if (action === "replace") playout.clear();
            const encoded = Buffer.from(payload.data.pcm, "base64");
            const pcm = payload.data.enc === "u" ? mulawToPcm16(encoded) : encoded;
            spkFrames++;
            spkBytes += pcm.length;
            playout.write(pcm);
            break;
          }
          case "voice-agent/grok-event": {
            const payload = GrokEventPayload.safeParse(event.payload);
            if (!payload.success) {
              invalidEvents++;
              continue;
            }
            handleGrokEvent(payload.data.event);
            break;
          }
        }
      }
    },
  });

  /* One RPC starts a call that outlives this process — the device's shape. */
  using worker = itx.workers.get(
    voiceAgentRef,
  ) as unknown as DynamicWorkerCapability<VoiceAgentWorker>;
  await discardRpcResult(
    stream.append({
      type: "voice-agent/call-requested",
      payload: { callId, effort: "none", bridge: "worker-detached" },
    }),
  );
  const started = await withRpcResult(
    worker.startCall({
      callId,
      effort: "none",
      path: streamPath,
      ...(options.greet ? { greet: options.greet } : {}),
      ...(options.grokBaseUrl ? { grokBaseUrl: options.grokBaseUrl } : {}),
    }),
    ({ ok, reason }) => ({ ok, reason }),
  );
  if (started.ok !== true) {
    throw new Error(`worker.startCall refused: ${started.reason ?? "unknown"}`);
  }

  const acceptDeadline = Date.now() + 20_000;
  while (!accepted) {
    if (Date.now() > acceptDeadline) {
      throw new Error("No call-accepted within 20s — is the voice agent installed?");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /*
   * MANUAL TURNS, like every board: a turn marker opens the microphone, the
   * commit closes it. Scripted mode holds one turn for the whole utterance;
   * interactive mode maps the spacebar to the talk button.
   */
  const markTurn = (action: "start" | "commit") => {
    /* The exact firmware payload shape: {callId, action, t}. */
    fireAppend({
      type: "voice-agent/turn",
      ephemeral: true,
      payload: { callId, action, t: Date.now() },
    });
  };
  let micSeq = 0;
  let pending: { seq: number; t: number; enc: "u"; pcm: string }[] = [];
  mic.on("frame", (frame: Buffer) => {
    if (!talking) return;
    pending.push({
      seq: micSeq++,
      t: Date.now(),
      enc: "u",
      pcm: pcm16ToMulaw(frame).toString("base64"),
    });
    if (pending.length >= framesPerAppend) {
      const events = pending.map((payload) => ({
        type: "voice-agent/mic-frame",
        ephemeral: true as const,
        payload: { callId, ...payload },
      }));
      pending = [];
      micFramesSent += events.length;
      fireAppend(...events);
    }
  });
  mic.start();

  /*
   * The ping is the only pulled traffic on this lane once a call is quiet:
   * without it the resilient connection's quiet watchdog reopens every few
   * seconds and each overlap gap can eat ephemeral answer frames forever —
   * exactly like the firmware, the client keeps a pong flowing.
   */
  const pingTimer = setInterval(() => {
    fireAppend({
      type: "voice-agent/ping",
      ephemeral: true,
      payload: { id: crypto.randomUUID().slice(0, 8), t0: Date.now() },
    });
  }, 2000);

  const startTalking = () => {
    if (talking) return;
    talking = true;
    micSeq = 0;
    playout.clear();
    classifier.interrupt();
    markTurn("start");
    console.error("voice: turn start");
  };
  const stopTalking = () => {
    if (!talking) return;
    if (pending.length > 0) {
      const events = pending.map((payload) => ({
        type: "voice-agent/mic-frame",
        ephemeral: true as const,
        payload: { callId, ...payload },
      }));
      pending = [];
      micFramesSent += events.length;
      fireAppend(...events);
    }
    talking = false;
    markTurn("commit");
    console.error("voice: turn commit");
  };

  if (options.mic) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (key: Buffer) => {
      const char = key.toString();
      if (char === " ") {
        if (talking) stopTalking();
        else startTalking();
      } else if (char === "q" || char === "") {
        done?.();
      }
    });
    console.error("voice: space starts/commits a turn, q quits");
  } else {
    /* Scripted: one turn spanning the synthetic utterance, then commit. */
    startTalking();
    const drainTimer = setInterval(() => {
      if (mic.pendingBytes() === 0 && talking) {
        stopTalking();
        clearInterval(drainTimer);
      }
    }, FRAME_MS);
  }
  process.on("SIGINT", () => done?.());

  await finished;
  clearInterval(pingTimer);
  if (talking) stopTalking();
  mic.stop();
  playout.stop();
  fireAppend({ type: "voice-agent/call-ended", payload: { callId, reason: "client done" } });
  await appendResults.drain();
  connection.close();

  const summary = {
    role: "kit-voice-cli",
    path: streamPath,
    callId,
    auth: auth.type,
    micFramesSent,
    spkFrames,
    spkSeconds: +(spkBytes / BYTES_PER_SEC).toFixed(2),
    playout: playout.stats(),
    identity: classifier.counters,
    bargeIns,
    connection: connection.stats(),
    appendErrors,
    invalidEvents,
    ...(firstError === undefined ? {} : { firstError }),
    userTranscript,
    assistantTranscript: assistantTranscript.trim(),
  };
  if (options.out) fs.writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.appendErrors > 0 || summary.invalidEvents > 0) process.exitCode = 2;
  return summary;
}

/* --- argv ------------------------------------------------------------------ */

function parseArgs(argv: string[]): VoiceCliOptions {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index++;
    }
  }
  const required = (name: string): string => {
    const value = options[name];
    if (typeof value !== "string") throw new Error(`--${name} is required`);
    return value;
  };
  return {
    baseUrl: required("base-url"),
    project: required("project"),
    projectApiKey:
      typeof options["project-api-key"] === "string"
        ? options["project-api-key"]
        : process.env.ITERATE_PROJECT_API_KEY?.trim() || undefined,
    adminSecret: process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() || undefined,
    path: typeof options.path === "string" ? options.path : undefined,
    say: typeof options.say === "string" ? options.say : undefined,
    pcm: typeof options.pcm === "string" ? options.pcm : undefined,
    mic: options.mic === true,
    device: options.device === true,
    turns: typeof options.turns === "string" ? Number(options.turns) : undefined,
    framesPerAppend:
      typeof options["frames-per-append"] === "string"
        ? Number(options["frames-per-append"])
        : undefined,
    greet: typeof options.greet === "string" ? options.greet : undefined,
    grokBaseUrl:
      typeof options["grok-base-url"] === "string" ? options["grok-base-url"] : undefined,
    out: typeof options.out === "string" ? options.out : undefined,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  voiceCli(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
