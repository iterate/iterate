// Latency-floor baseline: mic straight into Grok's WebSocket, audio straight back.
// No iterate infra in the path. Same synthetic-utterance flow and summary shape as
// `voicelab client`, so numbers subtract cleanly.
//
//   XAI_API_KEY=… pnpm cli voicelab direct --say "What is the capital of France?"
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path_ from "node:path";
import process from "node:process";
import { MicSource, PlayoutBuffer, percentiles, BYTES_PER_SEC } from "./audio.ts";
import { GrokClient } from "./grok.ts";

/** Options for `pnpm cli voicelab direct`. */
export interface DirectOptions {
  /** Synthesize this utterance with macOS `say` and use it as the mic. */
  say?: string;
  /** Raw 16kHz mono PCM16 file to use as the mic. */
  pcm?: string;
  /** Use the real microphone. */
  mic?: boolean;
  /** Play responses through the real speaker. */
  device?: boolean;
  /** Exit after this many completed responses (0 = run until Ctrl+C). */
  turns?: number;
  /** Grok model. */
  model?: string;
  /** Grok voice. */
  voice?: string;
  /** Reasoning effort: none (fast) or high (thinking). */
  effort?: string;
}

export async function direct(options: DirectOptions = {}) {
  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey) throw new Error("XAI_API_KEY is required.");
  const turnsTarget = options.turns ?? (options.mic ? 0 : 1);

  let syntheticPcmPath = options.pcm;
  if (!options.mic && !syntheticPcmPath) {
    const text =
      options.say ?? "What is the capital of France? Please answer in one short sentence.";
    const dir = fs.mkdtempSync(path_.join(os.tmpdir(), "voicelab-"));
    const aiff = path_.join(dir, "utterance.aiff");
    syntheticPcmPath = path_.join(dir, "utterance.pcm");
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
      syntheticPcmPath,
    ]);
  }

  const playout = new PlayoutBuffer({ device: options.device === true });
  const mic = new MicSource(syntheticPcmPath ? { syntheticPcmPath } : {});
  const grok = new GrokClient({
    apiKey,
    ...(options.model ? { model: options.model } : {}),
    ...(options.voice ? { voice: options.voice } : {}),
    reasoningEffort: options.effort === "high" ? "high" : "none",
  });

  const marks: Record<string, number> = {};
  const interArrival: number[] = [];
  let lastAudioAt: number | null = null;
  let spkFrames = 0;
  let spkBytes = 0;
  let micFramesSent = 0;
  let turnsDone = 0;
  let userTranscript: string | null = null;
  let assistantTranscript = "";
  let finishRequested = false;
  let done: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  grok.connect();
  grok.on("ready", () => {
    mic.on("frame", (frame: Buffer) => {
      micFramesSent++;
      grok.sendAudio(frame);
    });
    mic.start();
  });
  grok.on("audio", (pcm: Buffer) => {
    const now = Date.now();
    marks.firstSpkFrame ??= now;
    if (lastAudioAt !== null) interArrival.push(now - lastAudioAt);
    lastAudioAt = now;
    spkFrames++;
    spkBytes += pcm.length;
    playout.write(pcm);
  });
  grok.on("event", (event: { type: string; [key: string]: unknown }) => {
    const now = Date.now();
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        playout.clear();
        break;
      case "input_audio_buffer.speech_stopped":
        marks.speechStopped = now;
        break;
      case "conversation.item.input_audio_transcription.updated":
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string") userTranscript = event.transcript;
        break;
      case "response.output_audio_transcript.delta":
        assistantTranscript += (event.delta as string) ?? "";
        break;
      case "response.done":
        turnsDone++;
        playout.endOfResponse();
        console.error(`direct: turn ${turnsDone} done — "${assistantTranscript.trim()}"`);
        if (turnsTarget > 0 && turnsDone >= turnsTarget && !finishRequested) {
          finishRequested = true;
          setTimeout(() => done?.(), Math.max(500, playout.depthMs() + 300));
        }
        break;
    }
  });
  grok.on("error", (error: Error) => {
    console.error(`direct: grok error: ${error.message}`);
  });
  process.on("SIGINT", () => done?.());

  await finished;
  mic.stop();
  playout.stop();
  grok.close();

  const utteranceEnd = mic.utteranceEndAt;
  const summary = {
    role: "direct",
    model: grok.options.model,
    config: { effort: grok.options.reasoningEffort, synthetic: !options.mic },
    micFramesSent,
    spkFrames,
    spkSeconds: +(spkBytes / BYTES_PER_SEC).toFixed(2),
    latency: {
      utteranceEndToFirstSpkFrameMs:
        utteranceEnd !== null && marks.firstSpkFrame !== undefined
          ? Math.round(marks.firstSpkFrame - (performance.timeOrigin + utteranceEnd))
          : null,
      speechStoppedToFirstSpkFrameMs:
        marks.speechStopped !== undefined && marks.firstSpkFrame !== undefined
          ? Math.round(marks.firstSpkFrame - marks.speechStopped)
          : null,
      spkInterArrivalMs: percentiles(interArrival),
    },
    playout: playout.stats(),
    userTranscript,
    assistantTranscript: assistantTranscript.trim(),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}
