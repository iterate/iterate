// Poll one board's health through a whole two-utterance call and print the
// result as a table over time.
//
// THIS EXISTS BECAUSE A BEFORE/AFTER READ CANNOT SEE A DUCK. `boards --barge`
// samples the counters either side of an interruption, which answers "did it
// notice"; it cannot answer "what was the microphone doing at the moment the
// speaker started", and that turned out to be the whole question on the HA
// Voice PE. One row every 700ms against `speakerPlaying` made a 34 dB
// collapse obvious in a single screen.
import process from "node:process";
import { spawn } from "node:child_process";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

/** Options for `pnpm cli voicelab timeline`. */
export interface TimelineOptions extends VoicelabConnectOptions {
  /** Capability the device mounts itself under (itx.kit.<name>). */
  name?: string;
  /** What to say first. Must be something with a long answer to interrupt. */
  prompt?: string;
  /** What to say OVER that answer. */
  interruption?: string;
  /** Milliseconds between health samples. */
  everyMs?: number;
  /** Milliseconds to wait after the first utterance before interrupting. */
  beforeInterruptionMs?: number;
}

/** The fields worth a column; everything else is in `device --action health`. */
const COLUMNS = [
  "callActive",
  "speakerPlaying",
  "framesSent",
  "micCaptured",
  "micIdle",
  "micPeak",
  /*
   * RAW AND CLEAN, SIDE BY SIDE, because "the microphone went quiet" has two
   * completely different causes and only this pair separates them. Raw is the
   * tap before the board's processing; clean is after. Both collapsing means
   * the signal never arrived. Only clean collapsing means we did it.
   * Boards that do not publish these show "-" rather than a zero, which would
   * read as a measurement.
   */
  "micRawPeak",
  "micCleanPeak",
  "echoRawPeak",
  "echoCleanPeak",
  /*
   * The gate's own decisions. `echoFramesMuted` climbing while
   * `gateLoudestRefused` sits just under the floor is the whole HA Voice PE
   * story in two columns.
   */
  "echoFramesMuted",
  "gateRefused",
  "gateLoudestRefused",
  "bargeIns",
  "spkSupersededMidplay",
  "spkAnswerStarts",
] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const say = (text: string) =>
  new Promise<void>((resolve) => {
    spawn("say", ["-r", "170", text], { stdio: "ignore" }).on("close", () => resolve());
  });

export async function timeline(options: TimelineOptions) {
  const name = options.name ?? "homeAssistantVoicePreviewEdition";
  const everyMs = options.everyMs ?? 700;
  using itx = await connectProject(options);
  const kit = (itx as unknown as { kit: Record<string, any> }).kit;
  const board = kit[name];
  if (!board) throw new Error(`nothing mounted at kit.${name}`);

  const rows: { atMs: number; note?: string; values?: Record<string, unknown> }[] = [];
  const startedAt = Date.now();
  let sampling = true;
  const note = (text: string) => rows.push({ atMs: Date.now() - startedAt, note: text });

  await board.conversation.start();
  const sampler = (async () => {
    while (sampling) {
      try {
        const health = await board.health();
        rows.push({
          atMs: Date.now() - startedAt,
          values: Object.fromEntries(COLUMNS.map((key) => [key, health[key]])),
        });
      } catch {
        /* A board mid-remount answers nothing; the gap is the observation. */
        note("health unavailable");
      }
      await sleep(everyMs);
    }
  })();

  try {
    await sleep(6000);
    note("first utterance");
    await say(
      options.prompt ??
        "Please tell me a very long story about the mountains, at least forty seconds.",
    );
    note("first utterance done — waiting for the answer");
    await sleep(options.beforeInterruptionMs ?? 9000);
    note("INTERRUPTION");
    await say(options.interruption ?? "Stop. Stop talking. Say pineapple.");
    note("interruption done");
    await sleep(12000);
  } finally {
    sampling = false;
    await sampler;
    try {
      await board.conversation.hangUp();
    } catch {
      /* Ending a call that already ended is not this probe's business. */
    }
  }

  const header = ["ms", ...COLUMNS].join("\t");
  console.log(header);
  for (const row of rows) {
    if (row.note !== undefined) {
      console.log(`---- ${row.note} ----`);
      continue;
    }
    console.log(
      [String(row.atMs), ...COLUMNS.map((key) => String(row.values?.[key] ?? "-"))].join("\t"),
    );
  }
  /*
   * Nothing returned on purpose: the CLI renders a returned value as a table,
   * and a table of forty samples with nine columns each is unreadable — which
   * defeats the one thing this command exists to make obvious.
   */
}
