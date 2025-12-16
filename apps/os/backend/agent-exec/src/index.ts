/* eslint-disable no-console -- Container script output requires console */
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { logger } from "hono/logger";
import dedent from "dedent";

const app = new Hono();
app.use(logger());

type EnqueueFn = (stream: "stdout" | "stderr", message: string) => void;

async function execCommand(
  command: string,
  args: string[],
  options: { cwd?: string; stdin?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      shell: false,
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : process.env,
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

async function setupRepo(opts: {
  sessionDir: string;
  githubRepoUrl: string;
  githubToken: string;
  checkoutTarget: string;
  isCommitHash: boolean;
  workDir: string;
  enqueue?: EnqueueFn;
}) {
  const { sessionDir, githubRepoUrl, githubToken, checkoutTarget, isCommitHash, workDir } = opts;
  const enqueue = opts.enqueue ?? (() => {});

  enqueue("stdout", "Configuring GitHub CLI\n");
  const auth = await execCommand("/usr/bin/gh", ["auth", "login", "--with-token"], {
    stdin: githubToken,
    cwd: "/tmp",
  });
  if (auth.exitCode !== 0) throw new Error(`Failed to auth gh: ${auth.stderr}`);
  await execCommand("/usr/bin/gh", ["auth", "setup-git"], { cwd: "/tmp" });

  enqueue("stdout", `Cloning repository into ${sessionDir}\n`);
  const cloneArgs = ["repo", "clone", githubRepoUrl, sessionDir];
  if (!isCommitHash && checkoutTarget && checkoutTarget !== "main") {
    cloneArgs.push("--", "--depth", "1", "--branch", checkoutTarget);
  } else if (!isCommitHash) {
    cloneArgs.push("--", "--depth", "1");
  }
  const clone = await execCommand("/usr/bin/gh", cloneArgs, { cwd: "/tmp" });
  if (clone.exitCode !== 0) throw new Error(`Clone failed: ${clone.stderr}`);

  if (isCommitHash) {
    const fetch = await execCommand("git", ["fetch", "--depth", "1", "origin", checkoutTarget], { cwd: sessionDir });
    if (fetch.exitCode !== 0) throw new Error(`Fetch failed: ${fetch.stderr}`);
    const co = await execCommand("git", ["checkout", checkoutTarget], { cwd: sessionDir });
    if (co.exitCode !== 0) throw new Error(`Checkout failed: ${co.stderr}`);
  }

  const gitFilesOutput = await execCommand("git", ["ls-files"], { cwd: sessionDir });
  enqueue("stdout", `> git ls-files\n\n${gitFilesOutput.stdout}\n`);

  enqueue("stdout", "Installing dependencies\n");
  const install = await execCommand("pnpm", ["i", "--prefer-offline"], { cwd: workDir });
  if (install.exitCode !== 0)
    throw new Error(
      `Install failed (exit code ${install.exitCode}): ${install.stderr} / ${install.stdout}`,
    );
}

type Stream = "stdout" | "stderr";

type LogItem = {
  seq: number;
  ts: number;
  stream: Stream;
  message: string;
  event?: string;
};

type BatchLogStreamerOptions = {
  url: string;
  meta?: Record<string, unknown>;
  flushIntervalMs?: number;
  heartbeatIntervalMs?: number;
};

function createBatchLogStreamer(options: BatchLogStreamerOptions) {
  const { url, meta } = options;
  const flushIntervalMs = options.flushIntervalMs ?? 1000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;

  let seq = 0;
  let pending: LogItem[] = [];
  let lastHeartbeatAt = 0;
  let isFlushing = false;
  let currentFlushPromise: Promise<void> | null = null;
  let flushTimer: NodeJS.Timeout | undefined;

  const enqueue = (item: {
    stream: Stream;
    message: string;
    event?: string;
    complete?: boolean;
  }) => {
    seq += 1;
    pending.push({
      seq,
      ts: Date.now(),
      stream: item.stream,
      message: item.message,
      event: item.event,
    });
    if (item.complete) {
      void flush();
    }
  };

  const flush = async () => {
    if (isFlushing && currentFlushPromise) {
      await currentFlushPromise;
      return;
    }
    isFlushing = true;
    currentFlushPromise = (async () => {
      try {
        const now = Date.now();
        if (now - lastHeartbeatAt >= heartbeatIntervalMs) {
          try {
            await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...(meta ?? {}), logs: [] }),
            });
            lastHeartbeatAt = now;
          } catch {
            // ignore heartbeat errors
          }
        }

        while (true) {
          const batch = pending;
          if (batch.length === 0) break;
          pending = [];
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...(meta ?? {}), logs: batch }),
            });
            if (!res.ok) {
              pending = batch.concat(pending);
              break;
            }
            try {
              await res.json();
            } catch {
              // ignore parse errors
            }
          } catch {
            pending = batch.concat(pending);
            break;
          }
        }
      } finally {
        isFlushing = false;
        currentFlushPromise = null;
      }
    })();
    await currentFlushPromise;
  };

  const start = () => {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
  };

  const stop = async () => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = undefined;
    }
    await flush();
  };

  return { enqueue, flush, start, stop };
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

const ExecRequest = z.object({
  githubRepoUrl: z.string(),
  githubToken: z.string(),
  checkoutTarget: z.string(),
  isCommitHash: z.boolean(),
  connectedRepoPath: z.string().optional(),
  ingestUrl: z.string(),
  estateId: z.string(),
  processId: z.string(),
  command: z.string(),
  env: z.record(z.string(), z.string()).optional(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
});

app.get("/", (c) => c.json({ message: "🚀 Agent Exec Container Ready!" }));

app.post("/exec", zValidator("json", ExecRequest), async (c) => {
  const args = c.req.valid("json");
  const sessionDir = `/tmp/session-${args.processId}`;
  const workDir = args.connectedRepoPath
    ? path.join(sessionDir, args.connectedRepoPath)
    : sessionDir;

  const logStreamer = createBatchLogStreamer({
    url: args.ingestUrl,
    meta: { processId: args.processId },
    flushIntervalMs: 10_000,
    heartbeatIntervalMs: 10_000,
  });

  const runExec = async () => {
    logStreamer.start();
    logStreamer.enqueue({
      stream: "stdout",
      message: `<command> Running ${args.command} </command>\n`,
      event: "COMMAND_STARTED",
    });
    try {
      await setupRepo({
        sessionDir,
        githubRepoUrl: args.githubRepoUrl,
        githubToken: args.githubToken,
        checkoutTarget: args.checkoutTarget,
        isCommitHash: args.isCommitHash,
        workDir,
        enqueue: (stream, message) =>
          logStreamer.enqueue({
            stream,
            message: `<repo-setup> ${message.trim()} </repo-setup>\n`,
          }),
      });

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
    } catch (error) {
      logStreamer.enqueue({
        stream: "stderr",
        message: dedent`
          <command>${args.command}</command>
          <error>${error}</error>
        `,
        event: "COMMAND_FAILED",
        complete: true,
      });
      await logStreamer.flush();
    } finally {
      await logStreamer.stop();
    }
  };

  runExec().catch((err) => {
    console.error(`Exec error: ${err instanceof Error ? err.message : String(err)}`);
  });

  return c.json({ ok: true, processId: args.processId });
});

app.post(
  "/mkdir",
  zValidator("json", z.object({ path: z.string(), recursive: z.boolean().default(true) })),
  async (c) => {
    const { path: dirPath, recursive } = c.req.valid("json");
    try {
      fs.mkdirSync(dirPath, { recursive });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
);

app.get("/read-file", zValidator("query", z.object({ path: z.string() })), async (c) => {
  const { path: filePath } = c.req.valid("query");
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return c.json({ ok: false, error: "Not a file" }, 400);
    }

    const content = fs.readFileSync(filePath);
    const isText = !content.includes(0);

    if (isText) {
      return c.json({
        ok: true,
        encoding: "utf-8",
        content: content.toString("utf-8"),
        mimeType: guessMimeType(filePath),
      });
    } else {
      return c.json({
        ok: true,
        encoding: "base64",
        content: content.toString("base64"),
        mimeType: guessMimeType(filePath),
      });
    }
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".md": "text/markdown",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

const server = serve(
  {
    fetch: app.fetch,
    port: 3000,
    hostname: "0.0.0.0",
  },
  (addr: { address: string; port: number }) => {
    console.log(`Agent Exec Container running on ${addr.address}:${addr.port}`);
  },
);

const exitHandler = async (e: NodeJS.Signals) => {
  console.log(`Exiting with signal ${e}`);

  setTimeout(() => {
    process.exit(0);
  }, 5000);

  server.close(() => {
    console.log(`Server closed`);
    process.exit(0);
  });
};

process.on("SIGINT", exitHandler);
process.on("SIGTERM", exitHandler);
