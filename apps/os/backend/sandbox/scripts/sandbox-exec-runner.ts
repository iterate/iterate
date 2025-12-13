#!/opt/node24/bin/node
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import dedent from "dedent";
import { createBatchLogStreamer } from "./batch-http-log-streaming.ts";
import { setupRepo } from "./shared-sandbox-helpers.ts";

interface StartArgs {
  sessionDir: string;
  githubRepoUrl: string;
  githubToken: string;
  checkoutTarget: string;
  isCommitHash: boolean;
  connectedRepoPath?: string;
  ingestUrl: string;
  estateId: string;
  processId: string;
  command: string;
  env?: Record<string, string>;
  files?: Array<{ path: string; content: string }>;
}

function parseArgs<T>(): T {
  const jsonArg = process.argv[3];
  if (!jsonArg) throw new Error("Missing JSON arguments");
  return JSON.parse(jsonArg) as T;
}

async function spawnAndPipe(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> },
  onStdout: (data: string) => void,
  onStderr: (data: string) => void,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      shell: false,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    proc.stdout?.on("data", (d) => onStdout(d.toString()));
    proc.stderr?.on("data", (d) => onStderr(d.toString()));
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

async function start() {
  const args = parseArgs<StartArgs>();
  const workDir = args.connectedRepoPath
    ? path.join(args.sessionDir, args.connectedRepoPath)
    : args.sessionDir;

  const logStreamer = createBatchLogStreamer<string>({
    url: args.ingestUrl,
    meta: { processId: args.processId },
    flushIntervalMs: 10_000,
    heartbeatIntervalMs: 10_000,
  });
  logStreamer.start();
  logStreamer.enqueue({
    stream: "stdout",
    message: `<command> Running ${args.command} </command>\n`,
    event: "COMMAND_STARTED",
  });
  try {
    // Setup repository (auth, clone fresh, install deps)
    await setupRepo({
      sessionDir: args.sessionDir,
      githubRepoUrl: args.githubRepoUrl,
      githubToken: args.githubToken,
      checkoutTarget: args.checkoutTarget,
      isCommitHash: args.isCommitHash,
      workDir,
      enqueue: (stream, message) =>
        logStreamer.enqueue({ stream, message: `<repo-setup> ${message.trim()} </repo-setup>\n` }),
    });
    // Optionally write any files before running the command
    for (const f of args.files ?? []) {
      try {
        fs.writeFileSync(f.path, f.content, "utf8");
        logStreamer.enqueue({ stream: "stdout", message: `Wrote file ${f.path}` });
      } catch (err) {
        throw new Error(
          `Failed to write file ${f.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const exitCode = await spawnAndPipe(
      "bash",
      ["-lc", args.command],
      { cwd: workDir, env: args.env },
      (s) => logStreamer.enqueue({ stream: "stdout", message: s }),
      (s) => logStreamer.enqueue({ stream: "stderr", message: s }),
    );

    logStreamer.enqueue({
      stream: "stdout",
      message: `<command> Completed with exit code ${exitCode} </command>`,
      event: exitCode === 0 ? "COMMAND_SUCCEEDED" : "COMMAND_FAILED",
      complete: true,
    });
    await logStreamer.flush();
    process.exit(exitCode);
  } catch (error) {
    logStreamer.enqueue({
      stream: "stderr",
      message: dedent`
        <command>${args.command}</command>
        <error>${error}</error>
        <hotTake>This should never happen</hotTake>
      `,
      event: "COMMAND_FAILED",
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
