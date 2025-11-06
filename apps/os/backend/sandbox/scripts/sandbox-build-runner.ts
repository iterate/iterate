#!/opt/node24/bin/node
import { spawn } from "node:child_process";
import path from "node:path";

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

type Stream = "stdout" | "stderr";
type BuildEvent = "BUILD_STARTED" | "BUILD_SUCCEEDED" | "BUILD_FAILED" | "CONFIG_OUTPUT";
type LogItem = {
  seq: number;
  ts: number;
  stream: Stream;
  message: string;
  event?: BuildEvent;
};

async function start() {
  const args = parseArgs<StartArgs>();
  if (!args.sessionDir) throw new Error("sessionDir is missing");
  const repoDir = args.sessionDir;
  const workDir = args.connectedRepoPath
    ? path.join(args.sessionDir, args.connectedRepoPath)
    : args.sessionDir;

  // Batch logs and POST to DO every second
  let seq = 0;
  let pending: LogItem[] = [];
  const enqueue = (stream: Stream, message: string, event?: BuildEvent) => {
    seq += 1;
    pending.push({ seq, ts: Date.now(), stream, message, event });
  };
  let lastHeartbeatAt = 0;
  let isFlushing = false;
  const flush = async () => {
    if (isFlushing) return;
    isFlushing = true;
    const batch = pending;
    if (batch.length === 0) {
      // send heartbeat (empty logs) every 10s only
      const now = Date.now();
      if (now - lastHeartbeatAt >= 10_000) {
        try {
          await fetch(args.ingestUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ buildId: args.buildId, estateId: args.estateId, logs: [] }),
          });
          lastHeartbeatAt = now;
        } catch {}
      }
      isFlushing = false;
      return;
    }
    // create a new pending array; new enqueues will append there while batch is in-flight
    pending = [];
    try {
      const res = await fetch(args.ingestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buildId: args.buildId, estateId: args.estateId, logs: batch }),
      });
      if (!res.ok) {
        // requeue at the front to preserve order
        pending = batch.concat(pending);
        isFlushing = false;
        return;
      }
      // best-effort: read json to keep connection clean
      try {
        await res.json();
      } catch {}
    } catch {
      // put back to queue on error (front to preserve order)
      pending = batch.concat(pending);
    } finally {
      isFlushing = false;
    }
  };
  // initial marker
  enqueue("stdout", "[BUILD STARTED]", "BUILD_STARTED");
  const flushTimer = setInterval(() => {
    void flush();
  }, 1000);
  try {
    // GH auth
    enqueue("stdout", "Configuring GitHub CLI");
    const auth = await execCommand("gh", ["auth", "login", "--with-token"], {
      stdin: args.githubToken,
    });
    if (auth.exitCode !== 0) throw new Error(`Failed to auth gh: ${auth.stderr}`);
    await execCommand("gh", ["auth", "setup-git"]);

    // Always clone fresh repository into the session directory
    enqueue("stdout", "Cloning repository");
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
    enqueue("stdout", "Installing dependencies");
    const install = await execCommand("pnpm", ["i", "--prefer-offline"], { cwd: workDir });
    if (install.exitCode !== 0) throw new Error(`Install failed: ${install.stderr}`);

    // Run iterate, piping logs
    enqueue("stdout", "Running pnpm iterate");
    let iterateStdout = "";
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("pnpm", ["iterate"], { cwd: workDir, shell: false });
      proc.stdout?.on("data", (d) => {
        const s = d.toString();
        iterateStdout += s;
        enqueue("stdout", s);
      });
      proc.stderr?.on("data", (d) => enqueue("stderr", d.toString()));
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
      enqueue("stdout", jsonStr, "CONFIG_OUTPUT");
      await flush();
    }

    // Completed
    enqueue("stdout", "Build completed successfully");
    enqueue("stdout", "[BUILD SUCCEEDED]", "BUILD_SUCCEEDED");
    await flush();
    process.exit(0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    enqueue("stderr", `ERROR: ${msg}`);
    enqueue("stdout", "[BUILD FAILED]", "BUILD_FAILED");
    await flush();
    process.exit(1);
  } finally {
    clearInterval(flushTimer);
    await flush();
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
