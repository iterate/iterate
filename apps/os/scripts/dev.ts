// `pnpm dev` — the platform on this worktree's local workerd (Vite + the Cloudflare plugin), attached
// to the terminal as it always was, plus a detached lifecycle for agents, scripts and `pnpm getin`
// (scripts/getin.ts), which need a server that outlives their shell:
//
//   pnpm dev [--port N] [vite args]   attached; Ctrl-C stops it
//   pnpm dev start --detach [--port N]
//                                     in the background, logging to .wrangler/dev.log; returns once
//                                     `/version` answers (at once when this worktree's is already up)
//   pnpm dev status                   pid, port, URL — exit 1 when nothing is running
//   pnpm dev attach                   follow the log (Ctrl-C detaches; the server keeps running)
//   pnpm dev kill                     SIGTERM its process group, SIGKILL after 10s
//   pnpm dev restart [--port N]       kill, then start --detach on the same port
//
// Either way the running server is recorded in .wrangler/dev-server.json ({pid, port, baseUrl,
// startedAt, detached}) once `/version` answers — what `status`, `kill` and getin read. The record
// stays after the server stops: it is how a worktree keeps its port. Without `--port`, the port is this
// worktree's last recorded one, else 8788, else any free one — so two worktrees each keep their
// own, and the one that gets 8788 matches the Dash's documented `.dev.vars`
// (`ITERATE_ORIGIN=http://localhost:8788`).
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { build } from "./build.ts";

const root = path.resolve(import.meta.dirname, "..");
const stateDir = path.join(root, ".wrangler");
const recordPath = path.join(stateDir, "dev-server.json");
const logPath = path.join(stateDir, "dev.log");

const [command, ...rest] = process.argv.slice(2).filter((argument) => argument !== "--");
const commands: Record<string, (args: string[]) => Promise<void>> = {
  start: async (args) => {
    if (!args.includes("--detach")) return serve(args);
    const running = await runningServer();
    if (running) return console.log(`already running: ${describe(running)}`);
    await startDetached(args.filter((argument) => argument !== "--detach"));
  },
  status: async () => {
    const running = await runningServer();
    if (running) return console.log(`running: ${describe(running)}`);
    const last = readRecord();
    console.log(`not running${last ? ` (last on port ${last.port})` : ""}`);
    process.exitCode = 1;
  },
  attach: async () => {
    const running = await runningServer();
    if (running && !running.detached)
      throw new Error(`${describe(running)} runs attached: its output is in its own terminal`);
    if (!existsSync(logPath)) throw new Error(`no log at ${logPath}: \`pnpm dev start --detach\``);
    console.error(
      running
        ? `following ${describe(running)} — Ctrl-C detaches, the server keeps running`
        : `not running; the last log:`,
    );
    // `tail -F` follows by inotify/kqueue, and on through a restart's truncation
    const tail = spawn("tail", ["-n", "100", ...(running ? ["-F"] : []), logPath], {
      stdio: "inherit",
    });
    process.on("SIGINT", () => tail.kill("SIGINT"));
    await new Promise((resolve) => tail.on("exit", resolve));
  },
  kill: async () => {
    const running = await runningServer();
    if (!running) return console.log("not running");
    await stop(running.pid);
    console.log(`stopped pid ${running.pid}; port ${running.port} is free`);
  },
  restart: async (args) => {
    const running = await runningServer();
    if (running) await stop(running.pid);
    // without --port, `defaultPort` takes the recorded one, free again
    await startDetached(args);
  },
  // the detached server itself: `startDetached` spawns this with an IPC channel
  serve: (args) => serve(args),
};
await (command && command in commands ? commands[command]!(rest) : serve(process.argv.slice(2)));

/** Run the server in this process's foreground: build, `vite dev` as a child, the record once it
 *  answers. A detached one's `startDetached` hears "ready" over IPC. */
async function serve(argv: string[]) {
  const args = argv.filter((argument) => argument !== "--");
  const running = await runningServer();
  if (running)
    throw new Error(
      `this worktree's dev server is already running (${describe(running)}): \`pnpm dev attach\` or \`pnpm dev kill\``,
    );
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : await defaultPort();
  const viteArgs = portIndex >= 0 ? args : [...args, "--port", `${port}`];
  await build();
  const vite = spawn("pnpm", ["exec", "vite", "dev", ...viteArgs], {
    cwd: root,
    env: { ...process.env, CLOUDFLARE_ENV: "", OS_DEV_PORT: `${port}` },
    stdio: ["inherit", "inherit", "inherit"],
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => vite.kill(signal));
  vite.on("exit", (code) => process.exit(code ?? 0));
  const baseUrl = `http://localhost:${port}`;
  if (!(await answers(baseUrl, vite))) return;
  const record = {
    pid: process.pid,
    port,
    baseUrl,
    startedAt: new Date().toISOString(),
    detached: Boolean(process.send),
  };
  writeRecord(record);
  console.log(`dev server ready: ${describe(record)}`);
  if (process.send) {
    process.send({ ready: record });
    process.disconnect();
  }
}

/** `start --detach`: this script's `serve` in its own session and process group (so `kill` takes
 *  vite and workerd with it), stdout and stderr to the log, "ready" over the IPC channel — no
 *  waiting on files. Returns once it answers; a server that dies first fails with its log's tail. */
async function startDetached(args: string[]) {
  mkdirSync(stateDir, { recursive: true });
  const log = openSync(logPath, "w");
  // process.execArgv carries tsx's loader (`--import …/tsx/…`), so the child runs this .ts file
  const child = spawn(
    process.execPath,
    [...process.execArgv, import.meta.filename, "serve", ...args],
    { cwd: root, detached: true, stdio: ["ignore", log, log, "ipc"] },
  );
  closeSync(log);
  console.log(`starting the dev server (pid ${child.pid}, log ${logPath}) …`);
  const outcome = await new Promise<{ ready: DevServer } | { exit: number | null }>((resolve) => {
    child.on("message", (message) => resolve(message as { ready: DevServer }));
    child.on("exit", (code) => resolve({ exit: code }));
  });
  if ("exit" in outcome) {
    const tail = readFileSync(logPath, "utf8").split("\n").slice(-40).join("\n");
    throw new Error(`the dev server exited (${outcome.exit}) before answering:\n${tail}`);
  }
  child.unref();
  child.disconnect();
  console.log(`running: ${describe(outcome.ready)}`);
}

/** SIGTERM the server's process group (a detached one leads its own; an attached one's `serve`
 *  forwards the signal to vite), SIGKILL whatever is left after 10s. */
async function stop(pid: number) {
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      // not a group leader: an attached `pnpm dev`, which runs in its terminal's group
      process.kill(pid, name);
    }
  };
  signal("SIGTERM");
  for (let waited = 0; waited < 10_000 && alive(pid); waited += 200) await sleep(200);
  if (alive(pid)) signal("SIGKILL");
}

/** `/version` every 250ms until it answers, for up to 3 minutes (the first `vite dev` optimizes
 *  dependencies); false once vite has exited. */
async function answers(baseUrl: string, vite: ChildProcess) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && vite.exitCode === null) {
    const response = await fetch(`${baseUrl}/version`).catch(() => null);
    if (response?.ok) return true;
    await sleep(250);
  }
  if (vite.exitCode !== null) return false;
  throw new Error(`${baseUrl}/version did not answer within 3 minutes`);
}

type DevServer = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: string;
  /** started by `start --detach`: its output is in the log */
  detached: boolean;
};

/** The recorded server, when its process is alive and it answers `/version` (not some other
 *  process that inherited the pid or the port). */
async function runningServer() {
  const record = readRecord();
  if (!record || !alive(record.pid)) return null;
  const response = await fetch(`${record.baseUrl}/version`).catch(() => null);
  return response?.ok ? record : null;
}

function readRecord(): DevServer | null {
  return existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null;
}

function writeRecord(record: DevServer) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

async function defaultPort() {
  const last = readRecord()?.port;
  for (const port of [last, 8788]) if (port && !(await taken(port))) return port;
  return new Promise<number>((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Whether something accepts connections on `port` at localhost's either address — a connect, not
 *  a trial listen: macOS lets a listen on the wildcard address succeed beside a vite bound to
 *  127.0.0.1 (SO_REUSEADDR, which Node sets). */
async function taken(port: number) {
  const accepts = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ port, host }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  return (await accepts("127.0.0.1")) || (await accepts("::1"));
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function describe(server: DevServer) {
  return `${server.baseUrl} (pid ${server.pid}, since ${server.startedAt})`;
}
