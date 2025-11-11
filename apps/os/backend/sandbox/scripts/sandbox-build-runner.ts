#!/opt/node24/bin/node
import { spawn } from "node:child_process";
import path from "node:path";
import { setupRepo } from "./shared-sandbox-helpers.ts";
import { createBatchLogStreamer } from "./batch-http-log-streaming.ts";

interface StartArgs {
  sessionDir: string;
  githubRepoUrl: string;
  githubToken: string;
  checkoutTarget: string;
  isCommitHash: boolean;
  connectedRepoPath?: string;
  ingestUrl: string;
  buildId: string;
  estateId: string;
}

function parseArgs<T>(): T {
  const jsonArg = process.argv[3];
  if (!jsonArg) throw new Error("Missing JSON arguments");
  return JSON.parse(jsonArg) as T;
}

async function start() {
  const args = parseArgs<StartArgs>();
  if (!args.sessionDir) throw new Error("sessionDir is missing");
  const workDir = args.connectedRepoPath
    ? path.join(args.sessionDir, args.connectedRepoPath)
    : args.sessionDir;

  type BuildEvent = "BUILD_STARTED" | "BUILD_SUCCEEDED" | "BUILD_FAILED" | "CONFIG_OUTPUT";

  // Create a reusable HTTP flusher for all logs in this session
  const logStreamer = createBatchLogStreamer<BuildEvent>({
    url: args.ingestUrl,
    meta: { buildId: args.buildId, estateId: args.estateId },
    flushIntervalMs: 1000,
    heartbeatIntervalMs: 10_000,
  });
  logStreamer.start();
  logStreamer.enqueue({ stream: "stdout", message: "[BUILD STARTED]", event: "BUILD_STARTED" });
  try {
    // Setup repo (auth, clone fresh, install)
    await setupRepo({
      sessionDir: args.sessionDir,
      githubRepoUrl: args.githubRepoUrl,
      githubToken: args.githubToken,
      checkoutTarget: args.checkoutTarget,
      isCommitHash: args.isCommitHash,
      workDir,
      enqueue: (s, m) => logStreamer.enqueue({ stream: s, message: m }),
    });
    // Run iterate, piping logs
    logStreamer.enqueue({ stream: "stdout", message: "Running pnpm iterate" });
    let iterateStdout = "";
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("pnpm", ["iterate"], { cwd: workDir, shell: false });
      proc.stdout?.on("data", (d) => {
        const s = d.toString();
        iterateStdout += s;
        logStreamer.enqueue({ stream: "stdout", message: s });
      });
      proc.stderr?.on("data", (d) =>
        logStreamer.enqueue({ stream: "stderr", message: d.toString() }),
      );
      proc.on("error", (err) => reject(err));
      proc.on("close", (code) => {
        if ((code ?? 1) === 0) resolve();
        else reject(new Error(`pnpm iterate failed with code ${code}`));
      });
    });

    // Try to extract last JSON object as iterate config and emit typed event
    const jsonMatch = iterateStdout.match(/\{[\s\S]*\}(?![\s\S]*\{)/);
    if (jsonMatch) {
      const jsonStr = jsonMatch[0];
      logStreamer.enqueue({ stream: "stdout", message: jsonStr, event: "CONFIG_OUTPUT" });
      await logStreamer.flush();
    }

    // Completed
    logStreamer.enqueue({ stream: "stdout", message: "Build completed successfully" });
    logStreamer.enqueue({
      stream: "stdout",
      message: "[BUILD SUCCEEDED]",
      event: "BUILD_SUCCEEDED",
      complete: true,
    });
    await logStreamer.flush();
    process.exit(0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStreamer.enqueue({ stream: "stderr", message: `ERROR: ${msg}` });
    logStreamer.enqueue({
      stream: "stdout",
      message: "[BUILD FAILED]",
      event: "BUILD_FAILED",
      complete: true,
    });
    await logStreamer.flush();
    process.exit(1);
  } finally {
    await logStreamer.stop();
  }
}

async function main() {
  const sub = process.argv[2];
  if (sub !== "start") throw new Error("Unknown subcommand");
  await start();
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- we want to log the error to the console
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
