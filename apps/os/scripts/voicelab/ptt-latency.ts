// Press-to-answer latency against a REAL provider, with a synthetic
// microphone, repeated enough times to have a distribution rather than an
// anecdote.
//
// The question this answers is the only one that matters for push-to-talk:
// somebody holds a button, speaks for two or three seconds, lets go — how long
// until they hear something back? Everything else (handshake, flush, first
// frame) is reported alongside so a bad number can be attributed rather than
// merely observed.
//
//   doppler run --config preview_3 -- pnpm cli voicelab ptt-latency \
//     --project facet-proof-1 --stream-path /agents/voice/ptt-1 --rounds 10
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { discardRpcResult } from "./rpc-ownership.ts";

/** Options for `pnpm cli voicelab ptt-latency`. */
export interface PttLatencyOptions extends VoicelabConnectOptions {
  /** The stream whose facet is under test. Must already be set up. */
  streamPath?: string;
  /** How many press-speak-release rounds to run. */
  rounds?: number;
  /** How long the synthetic speaker holds the button. */
  speakMs?: number;
  /** Seconds of quiet between rounds, so one answer finishes before the next. */
  settleMs?: number;
  /**
   * A PCM16 mono 16 kHz WAV to speak instead of the synthetic tone.
   *
   * STRONGLY PREFERRED, and the default tone is close to useless without it:
   * a provider transcribes what it hears, and a glide has no words in it, so
   * the model correctly answers nothing and every round reads as a timeout.
   * That is not a latency measurement, it is a measurement of silence.
   */
  micWav?: string;
}

const FRAME_MS = 20;
/** 20 ms of 16 kHz PCM16 = 320 samples = 640 bytes. */
const FRAME_SAMPLES = 320;

/**
 * A frame of synthetic speech.
 *
 * Not silence: a provider with a voice-activity model in front of it may
 * discard a turn that is entirely quiet, and a latency measured on a turn the
 * model ignored is not a latency. A gliding tone with an envelope is enough to
 * read as energy without pretending to be words.
 */
function syntheticFrame(index: number): string {
  const pcm = new Int16Array(FRAME_SAMPLES);
  for (let sample = 0; sample < FRAME_SAMPLES; sample++) {
    const t = (index * FRAME_SAMPLES + sample) / 16_000;
    const hz = 180 + 60 * Math.sin(t * 3);
    const envelope = 0.4 + 0.35 * Math.sin(t * 11);
    pcm[sample] = Math.round(Math.sin(2 * Math.PI * hz * t) * envelope * 12_000);
  }
  return Buffer.from(pcm.buffer).toString("base64");
}

/** Median, and the worst case, because a mean hides exactly the bad round. */
function summarize(values: number[]): { p50: number; p90: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  return { p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1]! };
}

/** The frames of a PCM16 mono 16 kHz WAV, base64, 20 ms at a time. */
function framesFromWav(file: string): string[] {
  const bytes = fs.readFileSync(file);
  /* Skip the RIFF header by finding the data chunk rather than assuming 44
   * bytes: a WAV written by anything other than us may carry extra chunks. */
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

/** One press-speak-release round, as the report records it. */
type Round = {
  round: number;
  /** Press -> the server's own record that a call is open. */
  callStartedMs: number | null;
  /** Press -> a usable provider session. */
  handshakeMs: number | null;
  /** How much captured audio the handshake made the server hold. */
  framesBuffered: number | null;
  /** RELEASE -> first audio back. The number a person actually feels. */
  answerMs: number | null;
  framesSent: number;
};

export async function pttLatency(options: PttLatencyOptions) {
  const streamPath = options.streamPath ?? "/agents/voice/ptt-1";
  const rounds = options.rounds ?? 10;
  const speakMs = options.speakMs ?? 2_500;
  const settleMs = options.settleMs ?? 6_000;
  const spoken = options.micWav === undefined ? null : framesFromWav(options.micWav);
  if (spoken !== null) {
    console.log(`  speaking ${spoken.length} real frames from ${options.micWav}`);
  }

  using itx = await connectProject(options);
  const stream = itx.streams.get(streamPath);

  const results: Round[] = [];

  for (let round = 0; round < rounds; round++) {
    const pressedAt = Date.now();
    await discardRpcResult(
      stream.append({
        type: "events.iterate.com/voice-agent/ptt-start",
        ephemeral: true,
        payload: { t: pressedAt },
      }),
    );

    /*
     * Frames go out as fast as the loop can push them, paced only to real
     * time — exactly what a device does. Nothing here waits for the server:
     * the whole point is that capture does not block on the handshake.
     */
    const frames = spoken === null ? Math.max(1, Math.round(speakMs / FRAME_MS)) : spoken.length;
    let framesSent = 0;
    for (let index = 0; index < frames; index++) {
      const due = pressedAt + index * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      void stream
        .append({
          type: "events.iterate.com/voice-agent/mic-frame",
          ephemeral: true,
          payload: { seq: index, pcm: spoken === null ? syntheticFrame(index) : spoken[index]! },
        })
        .catch(() => undefined);
      framesSent++;
    }

    const releasedAt = Date.now();
    await discardRpcResult(
      stream.append({
        type: "events.iterate.com/voice-agent/ptt-end",
        ephemeral: true,
        payload: { t: releasedAt },
      }),
    );

    let answerMs: number | null = null;
    try {
      await stream.waitForEvent({
        eventTypes: ["events.iterate.com/voice-agent/spk-frame"],
        timeoutMs: 30_000,
      });
      answerMs = Date.now() - releasedAt;
    } catch {
      /* A round that never answered is a data point, not a crash. */
    }

    /* The server's own account of the round, read back from the stream. */
    const flushed = await stream.getEvents({
      eventTypes: ["events.iterate.com/voice-agent/buffer-flushed"],
    });
    const started = await stream.getEvents({
      eventTypes: ["events.iterate.com/voice-agent/call-started"],
    });
    const latestFlush = flushed.at(-1)?.payload as
      | { frames?: number; handshakeMs?: number }
      | undefined;
    const latestStart = started.at(-1);

    results.push({
      round: round + 1,
      callStartedMs:
        latestStart === undefined ? null : Date.parse(latestStart.createdAt) - pressedAt,
      handshakeMs: latestFlush?.handshakeMs ?? null,
      framesBuffered: latestFlush?.frames ?? null,
      answerMs,
      framesSent,
    });
    console.log(
      `  round ${String(round + 1).padStart(2)}  ` +
        `handshake ${String(latestFlush?.handshakeMs ?? "-").padStart(5)}ms  ` +
        `buffered ${String(latestFlush?.frames ?? "-").padStart(3)}  ` +
        `release→audio ${String(answerMs ?? "TIMEOUT").padStart(6)}ms`,
    );

    if (round + 1 < rounds) await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  const answered = results.map((r) => r.answerMs).filter((v): v is number => v !== null);
  const handshakes = results.map((r) => r.handshakeMs).filter((v): v is number => v !== null);
  const report = {
    streamPath,
    rounds,
    speakMs,
    answeredRounds: answered.length,
    releaseToAudioMs: summarize(answered),
    handshakeMs: summarize(handshakes),
    results,
  };

  const runsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../.voicelab-runs",
  );
  fs.mkdirSync(runsDir, { recursive: true });
  const out = path.join(runsDir, `ptt-latency-${new Date().toISOString().replace(/\D/g, "")}.json`);
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n  answered ${answered.length}/${rounds}`);
  const summary = summarize(answered);
  if (summary !== null) {
    console.log(
      `  release→audio  p50 ${summary.p50}ms  p90 ${summary.p90}ms  max ${summary.max}ms`,
    );
  }
  const hs = summarize(handshakes);
  if (hs !== null) console.log(`  handshake      p50 ${hs.p50}ms  p90 ${hs.p90}ms`);
  console.log(`  ${out}\n`);
  if (answered.length < rounds) process.exitCode = 1;
  return report;
}
