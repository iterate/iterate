import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { os as orpc } from "@orpc/server";
import { z } from "zod";

import {
  localDevServerLogPath,
  readLocalDevServerInfo,
  releaseLocalDevServerInfo,
  type DevServerInfo,
} from "@iterate-com/shared/alchemy/local-dev-server";

const APP_ROOT = process.cwd();
const ALCHEMY_DIR = resolve(APP_ROOT, ".alchemy");
const LOG_PATH = localDevServerLogPath(APP_ROOT);
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_TIMEOUT_MS = 10_000;
const DEFAULT_HEAD_LINES = 80;
const DEFAULT_TAIL_LINES = 80;

const EmptyInput = z.object({});

// OS local dev lifecycle commands. `pnpm dev` and `pnpm cli dev` both default
// to attached start; use `pnpm cli dev start --detach`, `attach`, `restart`,
// `status`, or `kill` for the normal lifecycle controls. Alchemy still owns the
// worker topology; this file only manages its local process/log lifecycle.
const StartOptions = z.object({
  attach: z
    .boolean()
    .default(true)
    .describe("Keep this process attached to the dev server output."),
  detach: z
    .boolean()
    .default(false)
    .describe("Start in the background and return once the discovery file is published."),
});

export const devServerScripts = {
  status: orpc
    .meta({ description: "Show the recorded OS local dev server status." })
    .input(EmptyInput)
    .handler(async () => devServerStatus()),
  start: orpc
    .meta({
      default: true,
      description: "Start the OS local dev server, or attach if it is already running.",
    })
    .input(StartOptions)
    .handler(async ({ input }) => startDevServer(input)),
  restart: orpc
    .meta({ description: "Restart the OS local dev server." })
    .input(StartOptions)
    .handler(async ({ input }) => {
      assertLocalAlchemyDev();
      await killDevServer();
      return startDevServer(input);
    }),
  kill: orpc
    .meta({ description: "Stop the recorded OS local dev server." })
    .input(EmptyInput)
    .handler(async () => killDevServer()),
  attach: orpc
    .meta({ description: "Attach to the recorded OS local dev server log." })
    .input(EmptyInput)
    .handler(async () => attachToRecordedDevServer()),
};

type StartOptions = z.infer<typeof StartOptions>;

export async function runDevServerCommand(argv: string[]): Promise<number> {
  const parsed = parseDirectArgs(argv);

  // These actions only touch the per-worktree discovery/log files, so the
  // direct compatibility wrapper can run them without entering Doppler first.
  // The ORPC app CLI still follows the repo-wide `pnpm cli` Doppler pattern.
  if (parsed.action === "status") {
    process.stdout.write(`${JSON.stringify(await devServerStatus(), null, 2)}\n`);
    return 0;
  }

  if (parsed.action === "kill") {
    process.stdout.write(`${JSON.stringify(await killDevServer(), null, 2)}\n`);
    return 0;
  }

  if (parsed.action === "attach") {
    await attachToRecordedDevServer();
    return 0;
  }

  // `scripts/dev.ts` is kept as a compatibility entrypoint for dev:local and
  // direct script invocations. It re-enters itself inside Doppler for starts,
  // preserving the user's local `doppler setup` unless a config was explicit.
  // For restart, do this before killing the current server: if Doppler cannot
  // start, the already-running server should be left alone.
  if (parsed.useDoppler && !process.env.DOPPLER_CONFIG) {
    const dopplerArgs = [
      "run",
      ...(parsed.config ? ["--config", parsed.config] : []),
      "--",
      "tsx",
      "./scripts/dev.ts",
      "--no-doppler",
      ...parsed.forwardedArgv,
    ];
    return spawnSyncExitCode("doppler", dopplerArgs);
  }

  if (parsed.action === "restart") {
    await killDevServer();
  }

  const result = await startDevServer(parsed.start);
  if (parsed.start.detach || !parsed.start.attach) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return "exitCode" in result ? result.exitCode : 0;
}

async function startDevServer({
  attach = true,
  detach = false,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
}: StartOptions & { timeoutMs?: number }) {
  assertLocalAlchemyDev();
  const shouldStream = !detach && attach;
  const existing = readLocalDevServerInfo(APP_ROOT, { requireLive: true });
  if (existing) {
    // One server per worktree: starting again attaches to the known live
    // process instead of trying to race Alchemy's own local state.
    console.info(`OS dev server already running: ${existing.baseUrl} (pid ${existing.pid})`);
    if (shouldStream) await attachToDevServer(existing);
    return formatStatus(existing);
  }

  if (shouldStream) {
    return startAttachedDevServer();
  }

  return startDetachedDevServer(timeoutMs);
}

async function startAttachedDevServer() {
  mkdirSync(ALCHEMY_DIR, { recursive: true });
  const command = "tsx";
  const commandArgs = ["./alchemy.run.ts"];
  const log = createWriteStream(LOG_PATH, { flags: "w" });

  // Attach mode tees the child output to both the terminal and the log file so
  // later `pnpm cli dev attach` calls can show the same boot history.
  log.write(logHeader(command, commandArgs));

  const child = spawn(command, commandArgs, {
    env: {
      ...process.env,
      DEV_SERVER_LOG_PATH: LOG_PATH,
    },
    stdio: ["inherit", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => teeOutput(chunk, process.stdout, log));
  child.stderr?.on("data", (chunk: Buffer) => teeOutput(chunk, process.stderr, log));

  child.on("error", (error) => {
    console.error(error);
    log.write(`${error.stack ?? error.message}\n`);
    log.end(() => process.exit(1));
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => child.kill(signal));
  }

  return new Promise<{ exitCode: number }>((resolve) => {
    child.on("exit", (code, signal) => {
      log.end(() => {
        const exitCode = code ?? exitCodeForSignal(signal) ?? 1;
        process.exitCode = exitCode;
        resolve({ exitCode });
      });
    });
  });
}

async function startDetachedDevServer(timeoutMs: number) {
  mkdirSync(ALCHEMY_DIR, { recursive: true });
  const command = "tsx";
  const commandArgs = ["./alchemy.run.ts"];
  const logFd = openSync(LOG_PATH, "w");
  writeSync(logFd, logHeader(command, commandArgs));

  // Detached mode redirects stdout/stderr straight into the log file and then
  // waits for alchemy.run.ts to publish `.alchemy/dev-server.json`; that file,
  // not the spawned pid, is the source of truth for the real worker process.
  const child = spawn(command, commandArgs, {
    detached: true,
    env: {
      ...process.env,
      DEV_SERVER_LOG_PATH: LOG_PATH,
    },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  const info = await waitUntil(
    () => readLocalDevServerInfo(APP_ROOT, { requireLive: true }),
    timeoutMs,
    250,
  );
  if (!info) {
    throw new Error(
      `OS dev server did not publish .alchemy/dev-server.json within ${timeoutMs}ms. ` +
        `Check ${LOG_PATH}. Spawned pid: ${child.pid ?? "unknown"}.`,
    );
  }

  console.info(`Started OS dev server: ${info.baseUrl} (pid ${info.pid})`);
  return formatStatus(info);
}

async function killDevServer() {
  const info = readLocalDevServerInfo(APP_ROOT, { requireLive: true });
  if (!info) {
    return { killed: false, message: "No live OS dev server recorded for this worktree." };
  }

  // SIGTERM gives alchemy/vite a chance to mark dev-server.json stopped. We
  // keep SIGKILL out of the public CLI so normal usage has fewer foot-guns.
  process.kill(info.pid, "SIGTERM");
  const stopped = await waitUntil(() => !isPidAlive(info.pid), DEFAULT_KILL_TIMEOUT_MS, 100);
  if (!stopped) {
    throw new Error(
      `OS dev server pid ${info.pid} did not exit after SIGTERM. Stop it manually if needed.`,
    );
  }

  releaseLocalDevServerInfo(APP_ROOT, info.pid);
  console.info(`Stopped OS dev server: ${info.baseUrl} (pid ${info.pid})`);
  return { killed: true, pid: info.pid, baseUrl: info.baseUrl };
}

async function attachToRecordedDevServer() {
  const info = readLocalDevServerInfo(APP_ROOT, { requireLive: true });
  if (!info) {
    throw new Error("No live OS dev server recorded for this worktree.");
  }
  return attachToDevServer(info);
}

async function attachToDevServer(info: DevServerInfo) {
  const logPath = info.logPath?.trim() || LOG_PATH;
  writeAttachPreamble(info, logPath);
  if (!existsSync(logPath)) {
    console.info("Waiting for log file...");
  }

  // Start following from the exact byte length we read for the excerpt. Lines
  // appended while the excerpt is being printed will still be picked up below.
  let offset = existsSync(logPath) ? writeLogExcerpt(logPath) : 0;

  await new Promise<void>((resolve) => {
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(interval);
      process.off("SIGINT", onSigint);
      resolve();
    };

    const onSigint = () => finish();
    process.once("SIGINT", onSigint);

    const interval = setInterval(() => {
      if (existsSync(logPath)) {
        const size = statSync(logPath).size;
        if (size < offset) offset = 0;
        if (size > offset) {
          // Read only the newly appended byte range; large logs should not be
          // reread from the beginning on every poll.
          createReadStream(logPath, { start: offset, end: size - 1 }).pipe(process.stdout, {
            end: false,
          });
          offset = size;
        }
      }
      if (!isPidAlive(info.pid)) finish();
    }, 500);
  });

  return formatStatus(info);
}

function teeOutput(chunk: Buffer, stream: NodeJS.WriteStream, log: NodeJS.WritableStream) {
  stream.write(chunk);
  log.write(chunk);
}

async function waitUntil<T>(
  read: () => T | false | null | undefined,
  timeoutMs: number,
  intervalMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return read() || null;
}

function devServerStatus() {
  return formatStatus(readLocalDevServerInfo(APP_ROOT));
}

function formatStatus(info: DevServerInfo | null) {
  if (!info) {
    return { live: false, recorded: false, logPath: LOG_PATH };
  }

  return {
    live: !info.stoppedAt && isPidAlive(info.pid),
    recorded: true,
    pid: info.pid,
    port: info.port,
    baseUrl: info.baseUrl,
    logPath: info.logPath ?? LOG_PATH,
    startedAt: info.startedAt,
    stoppedAt: info.stoppedAt,
  };
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertLocalAlchemyDev() {
  const isLocal = /^(1|true|yes)$/i.test(process.env.ALCHEMY_LOCAL?.trim() ?? "");
  if (!isLocal) {
    throw new Error(
      "Refusing to run the OS dev server because ALCHEMY_LOCAL is not true. " +
        `Doppler config ${process.env.DOPPLER_CONFIG ?? "(unset)"} would run ` +
        `stage ${process.env.ALCHEMY_STAGE ?? "(unset)"} as a deploy. ` +
        "Use doppler run --project os --config <config> -- pnpm deploy for intentional deployments.",
    );
  }
}

function writeAttachPreamble(info: DevServerInfo, logPath: string) {
  const baseUrl = new URL(info.baseUrl);
  const parentPid = spawnSync("ps", ["-o", "ppid=", "-p", String(info.pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).stdout?.trim();
  const status = !info.stoppedAt && isPidAlive(info.pid) ? "live" : "not live";
  const lines = [
    "Attaching to OS dev server",
    `Status: ${status}`,
    `Base URL: ${info.baseUrl}`,
    `Host: ${baseUrl.hostname}`,
    `Port: ${info.port}`,
    `PID: ${info.pid}`,
    ...(parentPid && /^\d+$/.test(parentPid) ? [`Parent PID: ${parentPid}`] : []),
    `Started: ${info.startedAt}`,
    ...(info.stoppedAt ? [`Stopped: ${info.stoppedAt}`] : []),
    `Log: ${logPath}`,
    "",
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

function writeLogExcerpt(path: string) {
  const log = readFileSync(path);
  const content = log.toString("utf8");
  if (content.trim().length === 0) return log.byteLength;

  const lines = content.split(/\r?\n/);
  if (lines.length <= DEFAULT_HEAD_LINES + DEFAULT_TAIL_LINES) {
    process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
    return log.byteLength;
  }

  // Show the boot header/config warnings at the start and the recent tail,
  // without dumping thousands of middle lines from a long-running server.
  const head = lines.slice(0, DEFAULT_HEAD_LINES).join("\n");
  const tail = lines.slice(-DEFAULT_TAIL_LINES).join("\n");
  const omitted = lines.length - DEFAULT_HEAD_LINES - DEFAULT_TAIL_LINES;

  process.stdout.write(`----- log start: first ${DEFAULT_HEAD_LINES} lines -----\n`);
  process.stdout.write(head.endsWith("\n") ? head : `${head}\n`);
  process.stdout.write(`----- omitted ${omitted} log lines -----\n`);
  process.stdout.write(`----- log tail: last ${DEFAULT_TAIL_LINES} lines -----\n`);
  process.stdout.write(tail.endsWith("\n") ? tail : `${tail}\n`);
  return log.byteLength;
}

function logHeader(command: string, commandArgs: string[]) {
  return [
    "# OS dev server log",
    `# Started: ${new Date().toISOString()}`,
    `# Command: ${[command, ...commandArgs].join(" ")}`,
    "",
    "",
  ].join("\n");
}

function spawnSyncExitCode(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error);
    return 1;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  return result.status ?? 1;
}

function exitCodeForSignal(signal: NodeJS.Signals | null) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return undefined;
}

const DIRECT_ACTIONS = ["attach", "kill", "restart", "start", "status"] as const;
type DirectAction = (typeof DIRECT_ACTIONS)[number];

function parseDirectArgs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      attach: { type: "boolean", default: true },
      config: { type: "string" },
      detach: { type: "boolean", default: false },
      "no-doppler": { type: "boolean", default: false },
    },
  });
  const first = positionals[0];
  const action = isDirectAction(first) ? first : "start";
  const extraPositionals = positionals.slice(isDirectAction(first) ? 1 : 0);
  if (extraPositionals.length > 0) {
    throw new Error(
      `Unexpected argument ${JSON.stringify(extraPositionals[0])}. Use doppler run --project os --config <config> -- pnpm deploy for intentional deployments.`,
    );
  }
  const attach = !values.detach && values.attach;
  const forwardedArgv = [...(action === "start" ? [] : [action]), ...(attach ? [] : ["--detach"])];

  return {
    action,
    config: values.config,
    forwardedArgv,
    start: { attach, detach: !attach, timeoutMs: DEFAULT_START_TIMEOUT_MS },
    useDoppler: !values["no-doppler"],
  };
}

function isDirectAction(value: string): value is DirectAction {
  return DIRECT_ACTIONS.includes(value as DirectAction);
}
