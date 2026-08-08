// What the SAME utterance costs with nothing of ours in the path.
//
// `ptt-latency` measures press-to-answer through the stream: an append per
// frame, a Durable Object, a facet, then the provider. This measures the same
// audio, paced the same way, over a WebSocket opened straight to the provider
// from this process. The difference between the two numbers is the price of
// going through Iterate, and without it "3 seconds" is a number nobody can
// act on — it might all be ours, or none of it.
//
//   doppler run --config preview_3 -- pnpm cli voicelab ptt-baseline \
//     --mic-wav /tmp/speech.wav --rounds 5
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Options for `pnpm cli voicelab ptt-baseline`. */
export interface PttBaselineOptions {
  /** PCM16 mono 16 kHz WAV to speak. Required: a tone has no words in it. */
  micWav: string;
  rounds?: number;
  /** Quiet between rounds, so one answer finishes before the next starts. */
  settleMs?: number;
  /** Provider endpoint. Defaults to xAI's realtime API. */
  grokBaseUrl?: string;
  model?: string;
  /**
   * Open ONE socket for all rounds (the facet's shape) rather than a fresh
   * one each time. Off by default, so the first number includes the handshake
   * a real press pays for.
   */
  reuse?: boolean;
}

const FRAME_MS = 20;
const FRAME_SAMPLES = 320;

function framesFromWav(file: string): string[] {
  const bytes = fs.readFileSync(file);
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

function summarize(values: number[]): { p50: number; p90: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  return { p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1]! };
}

/** The session shape the facet sends, so the two runs ask for the same thing. */
const sessionUpdate = {
  type: "session.update",
  session: {
    type: "realtime",
    audio: {
      input: { format: { type: "audio/pcm", rate: 16_000 }, turn_detection: null },
      output: { format: { type: "audio/pcm", rate: 16_000 }, voice: "eve" },
    },
  },
};

/** One socket, held open until the caller is done with it. */
type ProviderSession = Awaited<ReturnType<typeof dial>>;

async function dial(baseUrl: string, model: string, apiKey: string) {
  const target = new URL(baseUrl);
  target.searchParams.set("model", model);
  const { WebSocket } = await import("ws");
  const socket = new WebSocket(target.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const openedAt = Date.now();
  let readyAt: number | null = null;
  const audio: number[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", (raw: Buffer) => {
      let event: { type?: string };
      try {
        event = JSON.parse(raw.toString("utf8")) as { type?: string };
      } catch {
        return;
      }
      if (event.type === "session.created") socket.send(JSON.stringify(sessionUpdate));
      if (event.type === "session.updated") {
        readyAt = Date.now();
        resolve();
      }
      if (event.type === "response.output_audio.delta") audio.push(Date.now());
    });
  });
  return {
    socket,
    ready,
    openedAt,
    handshakeMs: () => (readyAt === null ? null : readyAt - openedAt),
    /** When the first audio of the CURRENT answer landed. */
    firstAudioAfter: (since: number) => audio.find((at) => at >= since) ?? null,
    send: (message: Record<string, unknown>) => socket.send(JSON.stringify(message)),
  };
}

export async function pttBaseline(options: PttBaselineOptions) {
  const apiKey = process.env.APP_CONFIG_X_AI_API_KEY?.trim() ?? "";
  if (apiKey === "") throw new Error("APP_CONFIG_X_AI_API_KEY is required for the baseline.");
  const rounds = options.rounds ?? 5;
  const settleMs = options.settleMs ?? 6_000;
  const baseUrl = options.grokBaseUrl ?? "https://api.x.ai/v1/realtime";
  const model = options.model ?? "grok-voice-think-fast-2.0";
  const spoken = framesFromWav(options.micWav);
  console.log(`  speaking ${spoken.length} real frames, ${rounds} rounds, direct to ${baseUrl}`);

  const answers: number[] = [];
  const handshakes: number[] = [];
  const results: { round: number; handshakeMs: number | null; answerMs: number | null }[] = [];
  let shared: ProviderSession | null = null;

  for (let round = 0; round < rounds; round++) {
    const session: ProviderSession =
      options.reuse && shared !== null ? shared : await dial(baseUrl, model, apiKey);
    if (options.reuse) shared = session;
    const pressedAt = Date.now();
    await session.ready;
    const handshakeMs = session.handshakeMs();
    if (handshakeMs !== null && (!options.reuse || round === 0)) handshakes.push(handshakeMs);

    /* Paced to real time, exactly as the stream probe paces it, so the two
     * runs put audio on the wire at the same rate. */
    for (let index = 0; index < spoken.length; index++) {
      const due = pressedAt + index * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      session.send({ type: "input_audio_buffer.append", audio: spoken[index]! });
    }
    const releasedAt = Date.now();
    session.send({ type: "input_audio_buffer.commit" });
    session.send({ type: "response.create" });

    let answerMs: number | null = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const at = session.firstAudioAfter(releasedAt);
      if (at !== null) {
        answerMs = at - releasedAt;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (answerMs !== null) answers.push(answerMs);
    results.push({ round: round + 1, handshakeMs, answerMs });
    console.log(
      `  round ${String(round + 1).padStart(2)}  ` +
        `handshake ${String(handshakeMs ?? "-").padStart(5)}ms  ` +
        `release→audio ${String(answerMs ?? "TIMEOUT").padStart(6)}ms`,
    );
    if (!options.reuse) session.socket.close();
    if (round + 1 < rounds) await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  shared?.socket.close();

  const report = {
    kind: "baseline-direct-to-provider",
    baseUrl,
    model,
    rounds,
    frames: spoken.length,
    answeredRounds: answers.length,
    releaseToAudioMs: summarize(answers),
    handshakeMs: summarize(handshakes),
    results,
  };
  const runsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../.voicelab-runs",
  );
  fs.mkdirSync(runsDir, { recursive: true });
  const out = path.join(
    runsDir,
    `ptt-baseline-${new Date().toISOString().replace(/\D/g, "")}.json`,
  );
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  const summary = summarize(answers);
  console.log(`\n  answered ${answers.length}/${rounds}`);
  if (summary !== null) {
    console.log(
      `  release→audio  p50 ${summary.p50}ms  p90 ${summary.p90}ms  max ${summary.max}ms`,
    );
  }
  const hs = summarize(handshakes);
  if (hs !== null) console.log(`  handshake      p50 ${hs.p50}ms`);
  console.log(`  ${out}\n`);
  return report;
}
