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
import { createImpairment, parseImpairSpec } from "./impair.ts";

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
  /** Barge-in test: speak this second utterance while the first answer plays. */
  say2?: string;
  /** Delay from first answer audio to the barge-in utterance (ms). */
  say2AfterMs?: number;
  /** Simulated bad network at the client's transport touchpoints (same syntax as `client`). */
  impair?: string;
  /** WebSocket endpoint override — point at a proxy speaking the Grok realtime protocol. */
  url?: string;
}

/** Silence between one answer ending and the next utterance starting. */
const TURN_GAP_MS = 400;

/**
 * One question and its answer, stamped on ONE clock.
 *
 * The summary this replaced was shaped for a single turn and said so in three
 * ways at once: it differenced `Date.now()` against `performance.now()` and
 * printed −59 seconds, it read `utteranceEnds[0]` however many turns ran, and
 * it pooled the gaps BETWEEN answers into a distribution meant to describe the
 * jitter WITHIN one. None of that mattered while `--turns` could not produce a
 * second turn. A latency floor is a median over repetitions, so it matters now.
 *
 * Everything here is `performance.now()`, which is what MicSource stamps its
 * utterance ends with, so no two fields need aligning.
 */
interface Turn {
  /** When the microphone stopped speaking the question. */
  askedAtMs: number;
  /** When the provider's own VAD decided the question had ended. */
  speechStoppedAtMs: number | null;
  /** When this answer's first sample arrived here. THE number. */
  firstAudioAtMs: number | null;
  /** When the provider said the answer was complete. */
  doneAtMs: number | null;
  /** Gaps between consecutive audio messages inside THIS answer. */
  gapsMs: number[];
  transcript: string;
}

export async function direct(options: DirectOptions = {}) {
  const apiKey = process.env.XAI_API_KEY?.trim() ?? "";
  if (!apiKey && !options.url) throw new Error("XAI_API_KEY is required (or pass --url).");
  const turnsTarget = options.turns ?? (options.mic ? 0 : options.say2 ? 2 : 1);
  const impair = createImpairment(parseImpairSpec(options.impair));
  if (impair.describe) console.error(`direct: impairment ${impair.describe}`);

  let syntheticPcmPath = options.pcm;
  if (!options.mic && !syntheticPcmPath) {
    const text =
      options.say ?? "What is the capital of France? Please answer in one short sentence.";
    const dir = fs.mkdtempSync(path_.join(os.tmpdir(), "voicelab-"));
    syntheticPcmPath = path_.join(dir, "utterance.pcm");
    fs.writeFileSync(syntheticPcmPath, synthesizePcm(text));
  }

  const say2Pcm = options.say2 ? synthesizePcm(options.say2) : null;
  /*
   * The utterance, kept so it can be said more than once. A real microphone
   * has a person behind it and needs no reservoir; a synthetic one is a file
   * that drains.
   */
  const repeatPcm =
    !options.mic && syntheticPcmPath !== undefined ? fs.readFileSync(syntheticPcmPath) : null;

  const playout = new PlayoutBuffer({ device: options.device === true });
  const mic = new MicSource(syntheticPcmPath ? { syntheticPcmPath } : {});
  const grok = new GrokClient({
    apiKey,
    ...(options.url ? { url: options.url } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.voice ? { voice: options.voice } : {}),
    reasoningEffort: options.effort === "high" ? "high" : "none",
  });

  /** Every turn this run asked, in order. Pending ones have nulls. */
  const turns: Turn[] = [];
  /** The turn currently being answered; null between answers. */
  let answering: Turn | null = null;
  let lastAudioAt: number | null = null;
  let firstAudioEverAt: number | null = null;
  let spkMessages = 0;
  let spkBytes = 0;
  let micFramesSent = 0;
  let turnsDone = 0;
  let userTranscript: string | null = null;
  let assistantTranscript = "";
  let finishRequested = false;
  let say2Injected = false;
  let bargeInAt: number | null = null;
  let bargeInReactionMs: number | null = null;
  const bargeInDrops: number[] = [];
  let done: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  grok.connect();
  grok.on("ready", () => {
    mic.on("frame", (frame: Buffer) => {
      micFramesSent++;
      impair.tx(() => grok.sendAudio(frame));
    });
    mic.start();
  });
  /*
   * A QUESTION ENDS WHEN THE MICROPHONE STOPS SAYING IT, and that is where a
   * turn begins for measuring purposes. Every later stamp attaches to the turn
   * this opens, so an answer can never be timed against the wrong question.
   */
  mic.on("utterance-end", (at: number) => {
    turns.push({
      askedAtMs: at,
      speechStoppedAtMs: null,
      firstAudioAtMs: null,
      doneAtMs: null,
      gapsMs: [],
      transcript: "",
    });
  });
  grok.on("audio", (pcm: Buffer) => {
    impair.rx(() => {
      const now = performance.now();
      if (firstAudioEverAt === null) {
        firstAudioEverAt = now;
        if (say2Pcm && !say2Injected) {
          say2Injected = true;
          setTimeout(() => {
            bargeInAt = performance.now();
            mic.inject(say2Pcm);
            console.error("direct: barge-in utterance injected");
          }, options.say2AfterMs ?? 1200);
        }
      }
      if (answering !== null) {
        if (answering.firstAudioAtMs === null) {
          answering.firstAudioAtMs = now;
        } else if (lastAudioAt !== null) {
          /* Within THIS answer only. Pooling across answers folded the pause
           * between turns into a jitter figure, where it is the largest sample
           * by an order of magnitude and describes nothing. */
          answering.gapsMs.push(now - lastAudioAt);
        }
      }
      lastAudioAt = now;
      spkMessages++;
      spkBytes += pcm.length;
      playout.write(pcm);
    });
  });
  grok.on("event", (rawEvent: { type: string; [key: string]: unknown }) =>
    impair.rx(() => handleEvent(rawEvent)),
  );
  /** The newest turn nobody has stamped `field` on yet. */
  const pending = (field: "speechStoppedAtMs"): Turn | null =>
    [...turns].reverse().find((turn) => turn[field] === null) ?? null;
  const handleEvent = (event: { type: string; [key: string]: unknown }) => {
    const now = performance.now();
    switch (event.type) {
      case "input_audio_buffer.speech_started": {
        const dropped = playout.clear();
        if (dropped > 0) bargeInDrops.push(Math.round(dropped));
        if (bargeInAt !== null && bargeInReactionMs === null) {
          bargeInReactionMs = Math.round(now - bargeInAt);
        }
        break;
      }
      case "input_audio_buffer.speech_stopped": {
        const turn = pending("speechStoppedAtMs");
        if (turn !== null) turn.speechStoppedAtMs = now;
        break;
      }
      case "conversation.item.input_audio_transcription.updated":
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string") userTranscript = event.transcript;
        break;
      case "response.created":
        /*
         * WHICH QUESTION THIS ANSWERS, decided once, here. Binding audio to
         * "the newest turn" instead would mis-attribute a barge-in: the
         * interrupted answer is still arriving when the interrupting question
         * ends, and those samples belong to the turn before.
         */
        answering = turns.find((turn) => turn.doneAtMs === null) ?? null;
        break;
      case "response.output_audio_transcript.delta":
        if (answering !== null) answering.transcript += (event.delta as string) ?? "";
        assistantTranscript += (event.delta as string) ?? "";
        break;
      case "response.done":
        turnsDone++;
        playout.endOfResponse();
        if (answering !== null) {
          answering.doneAtMs = now;
          console.error(`direct: turn ${turnsDone} done — "${answering.transcript.trim()}"`);
          answering = null;
        }
        if (turnsTarget > 0 && turnsDone >= turnsTarget && !finishRequested) {
          finishRequested = true;
          setTimeout(() => done?.(), Math.max(500, playout.depthMs() + 300));
          break;
        }
        /*
         * SAY IT AGAIN, because `--turns` was a counter with no producer.
         *
         * The synthetic microphone drains its utterance once and then emits
         * silence for ever, so anything above one turn waited for a
         * `response.done` that nothing could cause. It did not fail: it hung,
         * until xAI ended the conversation for 900 seconds of inactivity, and
         * the run reported nothing at all. A latency floor is a median over
         * repetitions, so a harness that can only do one repetition could
         * never answer the question it exists for.
         *
         * Waiting for the answer to finish playing before speaking again is
         * what a person does, and it keeps each turn's timings independent of
         * the previous answer's tail.
         */
        if (turnsTarget > 0 && repeatPcm !== null) {
          setTimeout(() => mic.inject(repeatPcm, TURN_GAP_MS), Math.max(0, playout.depthMs()));
        }
        break;
    }
  };
  grok.on("error", (error: Error) => {
    console.error(`direct: grok error: ${error.message}`);
  });
  process.on("SIGINT", () => done?.());

  await finished;
  mic.stop();
  playout.stop();
  grok.close();

  /** Only turns that actually got an answer can be timed. */
  const answered = turns.filter((turn) => turn.firstAudioAtMs !== null);
  const span = (from: number | null, to: number | null) =>
    from === null || to === null ? null : Math.round(to - from);
  const spans = (pick: (turn: Turn) => number | null) =>
    percentiles(answered.map(pick).filter((value): value is number => value !== null));

  const summary = {
    role: options.url ? "ws-proxy" : "direct",
    ...(options.url ? { url: options.url } : {}),
    model: grok.options.model,
    config: {
      effort: grok.options.reasoningEffort,
      synthetic: !options.mic,
      ...(impair.describe === null ? {} : { impairment: impair.describe }),
    },
    micFramesSent,
    /* Grok's audio deltas are of no fixed length, so this counts MESSAGES.
     * It read `spkFrames`, which invited reading it as 20 ms frames. */
    spkMessages,
    spkSeconds: +(spkBytes / BYTES_PER_SEC).toFixed(2),
    turnsAsked: turns.length,
    turnsAnswered: answered.length,
    latency: {
      /** THE FLOOR: microphone stops, first sample of the answer arrives. */
      askToFirstAudioMs: spans((turn) => span(turn.askedAtMs, turn.firstAudioAtMs)),
      /** How long the provider's VAD waits before calling the question over. */
      vadHangoverMs: spans((turn) => span(turn.askedAtMs, turn.speechStoppedAtMs)),
      /** And what it does after that: everything the provider owns. */
      vadToFirstAudioMs: spans((turn) => span(turn.speechStoppedAtMs, turn.firstAudioAtMs)),
      /** Gaps between audio messages, pooled over turns but never across one. */
      audioGapMs: percentiles(answered.flatMap((turn) => turn.gapsMs)),
    },
    playout: playout.stats(),
    ...(bargeInAt === null
      ? {}
      : { bargeIn: { reactionMs: bargeInReactionMs, droppedMs: bargeInDrops } }),
    turns: answered.map((turn) => ({
      askToFirstAudioMs: span(turn.askedAtMs, turn.firstAudioAtMs),
      vadHangoverMs: span(turn.askedAtMs, turn.speechStoppedAtMs),
      answerMs: span(turn.firstAudioAtMs, turn.doneAtMs),
      transcript: turn.transcript.trim(),
    })),
    userTranscript,
    assistantTranscript: assistantTranscript.trim(),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

/** Render text to raw 16kHz mono PCM16 via macOS `say` + sox. */
function synthesizePcm(text: string): Buffer {
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
  return fs.readFileSync(pcm);
}
