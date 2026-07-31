// Comparison-matrix runner: executes every topology under every simulated
// network profile, N runs each, and prints a compact results table plus a
// JSONL of full per-run summaries. Each run is a real Grok call with the
// same deterministic synthetic utterance.
//
//   XAI_API_KEY=… doppler run --config preview_3 -- pnpm cli voicelab matrix \
//     --project prj_… --worker-url wss://voice--voicelab.iterate-preview-3.app/ \
//     --runs 2 --out /tmp/voicelab-matrix.jsonl
import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { percentiles } from "./audio.ts";

/** Options for `pnpm cli voicelab matrix`. */
export interface MatrixOptions {
  /** Project id (prj_…) for the streams variants. */
  project: string;
  /** wss URL of the project's voice app (enables ws-proxy + streams-worker variants). */
  workerUrl?: string;
  /** Runs per cell. */
  runs?: number;
  /** Comma-separated variants: direct,ws-proxy,streams-node,streams-worker. */
  variants?: string;
  /** Comma-separated impairment profiles: none,bad,awful. */
  impairments?: string;
  /** Barge-in pass: second utterance interrupts the long first answer. */
  barge?: boolean;
  /** Write full per-run JSON summaries here (JSONL). */
  out?: string;
}

const IMPAIRMENTS: Record<string, string | null> = {
  none: null,
  bad: "tx=40,rx=40,jitter=60,stallEveryMs=7000,stallMs=400,seed=7",
  awful: "tx=120,rx=120,jitter=150,stallEveryMs=5000,stallMs=1800,seed=7",
};

interface RunRow {
  variant: string;
  impairment: string;
  run: number;
  ok: boolean;
  error?: string;
  ttfaMs?: number | null;
  stopToFirstMs?: number | null;
  oneWayP50?: number;
  oneWayP90?: number;
  rttP50?: number;
  underruns?: number;
  underrunMs?: number;
  reconnects?: number;
  appendErrors?: number;
  transcriptOk?: boolean;
  bargeReactionMs?: number | null;
}

export async function matrix(options: MatrixOptions) {
  const runs = options.runs ?? 2;
  const variants = (options.variants ?? "direct,ws-proxy,streams-node,streams-worker")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const impairments = (options.impairments ?? "none,bad,awful")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const needsWorker = variants.some((v) => v === "ws-proxy" || v === "streams-worker");
  if (needsWorker && !options.workerUrl) {
    throw new Error("--worker-url is required for ws-proxy / streams-worker variants");
  }
  if (variants.some((v) => v === "direct" || v === "streams-node") && !process.env.XAI_API_KEY) {
    throw new Error("XAI_API_KEY is required for direct / streams-node variants");
  }
  const stamp = Date.now().toString(36);
  const outPath = options.out ?? `/tmp/voicelab-matrix-${stamp}.jsonl`;
  const outStream = fs.createWriteStream(outPath, { flags: "a" });
  const rows: RunRow[] = [];

  const say = options.barge
    ? ["--say", "Please count slowly from one to thirty."]
    : ["--say", "What is the capital of France? Please answer in one short sentence."];
  const bargeArgs = options.barge
    ? ["--say2", "Stop counting. What is two plus two?", "--say2-after-ms", "1500"]
    : [];

  for (const variant of variants) {
    for (const impairment of impairments) {
      const impairSpec = IMPAIRMENTS[impairment];
      if (impairSpec === undefined) throw new Error(`unknown impairment: ${impairment}`);
      const impairArgs = impairSpec === null ? [] : ["--impair", impairSpec];
      const cellPath = `/voicelab/m${stamp}-${variant}-${impairment}`;

      let bridgeChild: ReturnType<typeof spawn> | null = null;
      if (variant === "streams-node") {
        bridgeChild = spawn(
          "pnpm",
          [
            "--silent",
            "cli",
            "voicelab",
            "bridge",
            "--project",
            options.project,
            "--path",
            cellPath,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("bridge startup timeout")), 60_000);
          bridgeChild!.stderr!.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes("bridge: listening")) {
              clearTimeout(timer);
              resolve();
            }
          });
          bridgeChild!.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`bridge exited early (${code})`));
          });
        }).catch((error: Error) => {
          console.error(`matrix: ${variant}/${impairment}: ${error.message}`);
        });
      }

      for (let run = 1; run <= runs; run++) {
        const args = buildArgs(variant, run);
        console.error(`matrix: ${variant} / ${impairment} / run ${run} …`);
        const row = await executeRun(variant, impairment, run, args);
        rows.push(row);
        outStream.write(JSON.stringify(row) + "\n");
        console.error(
          `matrix:   → ${row.ok ? "ok" : `FAIL(${row.error})`} ttfa=${row.ttfaMs ?? "-"} oneWayP50=${row.oneWayP50 ?? "-"} underruns=${row.underruns ?? "-"}`,
        );
      }
      bridgeChild?.kill("SIGINT");

      function buildArgs(variant: string, run: number): string[] {
        switch (variant) {
          case "direct":
            return ["voicelab", "direct", ...say, ...bargeArgs, ...impairArgs];
          case "ws-proxy": {
            const url = new URL(options.workerUrl!);
            url.searchParams.set("mode", "proxy");
            return [
              "voicelab",
              "direct",
              "--url",
              url.toString(),
              ...say,
              ...bargeArgs,
              ...impairArgs,
            ];
          }
          case "streams-node":
            return [
              "voicelab",
              "client",
              "--project",
              options.project,
              "--path",
              cellPath,
              ...say,
              ...bargeArgs,
              ...impairArgs,
            ];
          case "streams-worker":
            return [
              "voicelab",
              "client",
              "--project",
              options.project,
              "--path",
              `${cellPath}-r${run}`,
              "--worker-url",
              options.workerUrl!,
              ...say,
              ...bargeArgs,
              ...impairArgs,
            ];
          default:
            throw new Error(`unknown variant: ${variant}`);
        }
      }
    }
  }

  outStream.end();

  // Per-cell aggregate table.
  const lines: string[] = [];
  lines.push(
    "| variant | network | runs ok | ttfa ms (med) | stop→audio ms | 1-way p50/p90 | rtt p50 | underruns | reconnects | transcript |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const variant of variants) {
    for (const impairment of impairments) {
      const cell = rows.filter((r) => r.variant === variant && r.impairment === impairment);
      const ok = cell.filter((r) => r.ok);
      const med = (pick: (r: RunRow) => number | null | undefined) => {
        const values = ok
          .map(pick)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        if (values.length === 0) return "-";
        return String(percentiles(values).p50);
      };
      lines.push(
        `| ${variant} | ${impairment} | ${ok.length}/${cell.length} | ${med((r) => r.ttfaMs)} | ${med((r) => r.stopToFirstMs)} | ${med((r) => r.oneWayP50)}/${med((r) => r.oneWayP90)} | ${med((r) => r.rttP50)} | ${ok.reduce((a, r) => a + (r.underruns ?? 0), 0)} | ${ok.reduce((a, r) => a + (r.reconnects ?? 0), 0)} | ${ok.filter((r) => r.transcriptOk).length}/${ok.length} |`,
      );
    }
  }
  const table = lines.join("\n");
  console.log(table);
  console.error(`matrix: full per-run summaries in ${outPath}`);
}

async function executeRun(
  variant: string,
  impairment: string,
  run: number,
  args: string[],
): Promise<RunRow> {
  const base: RunRow = { variant, impairment, run, ok: false };
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn("pnpm", ["--silent", "cli", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    },
  );
  let summary: Record<string, unknown>;
  try {
    summary = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return {
      ...base,
      error: `no JSON (exit ${result.code}): ${result.stderr.split("\n").slice(-3).join(" / ").slice(0, 200)}`,
    };
  }
  const latency = (summary.latency ?? {}) as {
    utteranceEndToFirstSpkFrameMs?: number | null;
    speechStoppedToFirstSpkFrameMs?: number | null;
    spkOneWayMs?: { p50?: number; p90?: number };
    pingRttMs?: { p50?: number };
  };
  const playout = (summary.playout ?? {}) as { underruns?: number; underrunMs?: number };
  const connection = (summary.connection ?? {}) as {
    watchdogReopens?: number;
    proactiveRecycles?: number;
  };
  const bargeIn = summary.bargeIn as { reactionMs?: number | null } | undefined;
  const userTranscript = summary.userTranscript;
  return {
    ...base,
    ok: true,
    ttfaMs: latency.utteranceEndToFirstSpkFrameMs ?? null,
    stopToFirstMs: latency.speechStoppedToFirstSpkFrameMs ?? null,
    oneWayP50: latency.spkOneWayMs?.p50,
    oneWayP90: latency.spkOneWayMs?.p90,
    rttP50: latency.pingRttMs?.p50,
    underruns: playout.underruns ?? 0,
    underrunMs: playout.underrunMs ?? 0,
    reconnects: (connection.watchdogReopens ?? 0) + (connection.proactiveRecycles ?? 0),
    appendErrors: typeof summary.appendErrors === "number" ? summary.appendErrors : 0,
    transcriptOk:
      typeof userTranscript === "string" &&
      /capital of france|count.*(thirty|30)|two plus two/i.test(userTranscript),
    bargeReactionMs: bargeIn?.reactionMs ?? null,
  };
}
