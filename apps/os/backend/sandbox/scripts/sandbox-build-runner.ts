#!/opt/node24/bin/node
import { spawn } from "node:child_process";
import path from "node:path";
import { createBatchHttpFlusher } from "./batch-http-flusher.ts";

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

function execCommand(
  command: string,
  args: string[],
  options: { cwd?: string; stdin?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      shell: false,
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (options.stdin !== undefined && proc.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on("error", (error) =>
      resolve({ stdout, stderr: stderr + "\n" + error.message, exitCode: 1 }),
    );
  });
}


async function start() {
  const args = parseArgs<StartArgs>();
  if (!args.sessionDir) throw new Error("sessionDir is missing");
  const repoDir = args.sessionDir;
  const workDir = args.connectedRepoPath
    ? path.join(args.sessionDir, args.connectedRepoPath)
    : args.sessionDir;

  type BuildEvent = "BUILD_STARTED" | "BUILD_SUCCEEDED" | "BUILD_FAILED" | "CONFIG_OUTPUT";

  // Create a reusable HTTP flusher for all logs in this session
  const flusher = createBatchHttpFlusher<BuildEvent>({
    url: args.ingestUrl,
    meta: { buildId: args.buildId, estateId: args.estateId },
    flushIntervalMs: 1000,
    heartbeatIntervalMs: 10_000,
  });
  flusher.start();
  flusher.enqueue({ stream: "stdout", message: "[BUILD STARTED]", event: "BUILD_STARTED" });
  try {
    // GH auth
    flusher.enqueue({ stream: "stdout", message: "Configuring GitHub CLI" });
    const auth = await execCommand("gh", ["auth", "login", "--with-token"], {
      stdin: args.githubToken,
    });
    if (auth.exitCode !== 0) throw new Error(`Failed to auth gh: ${auth.stderr}`);
    await execCommand("gh", ["auth", "setup-git"]);

    // Always clone fresh repository into the session directory
    flusher.enqueue({ stream: "stdout", message: "Cloning repository" });
    const cloneArgs = ["repo", "clone", args.githubRepoUrl, repoDir];
    if (!args.isCommitHash && args.checkoutTarget && args.checkoutTarget !== "main") {
      cloneArgs.push("--", "--depth", "1", "--branch", args.checkoutTarget);
    } else if (!args.isCommitHash) {
      cloneArgs.push("--", "--depth", "1");
    }
    const clone = await execCommand("gh", cloneArgs);
    if (clone.exitCode !== 0) throw new Error(`Clone failed: ${clone.stderr}`);
    if (args.isCommitHash) {
      const co = await execCommand("git", ["checkout", args.checkoutTarget], { cwd: repoDir });
      if (co.exitCode !== 0) throw new Error(`Checkout failed: ${co.stderr}`);
    }

    // Install dependencies
    flusher.enqueue({ stream: "stdout", message: "Installing dependencies" });
    const install = await execCommand("pnpm", ["i", "--prefer-offline"], { cwd: workDir });
    if (install.exitCode !== 0) throw new Error(`Install failed: ${install.stderr}`);

    // Run iterate, piping logs
    flusher.enqueue({ stream: "stdout", message: "Running pnpm iterate" });
    let iterateStdout = "";
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("pnpm", ["iterate"], { cwd: workDir, shell: false });
      proc.stdout?.on("data", (d) => {
        const s = d.toString();
        iterateStdout += s;
        flusher.enqueue({ stream: "stdout", message: s });
      });
      proc.stderr?.on("data", (d) => flusher.enqueue({ stream: "stderr", message: d.toString() }));
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
      flusher.enqueue({ stream: "stdout", message: jsonStr, event: "CONFIG_OUTPUT" });
      await flusher.flush();
    }

    // Completed
    flusher.enqueue({ stream: "stdout", message: "Build completed successfully" });
    flusher.enqueue({ stream: "stdout", message: "[BUILD SUCCEEDED]", event: "BUILD_SUCCEEDED" });
    await flusher.flush();
    process.exit(0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    flusher.enqueue({ stream: "stderr", message: `ERROR: ${msg}` });
    flusher.enqueue({ stream: "stdout", message: "[BUILD FAILED]", event: "BUILD_FAILED" });
    await flusher.flush();
    process.exit(1);
  } finally {
    await flusher.stop();
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
