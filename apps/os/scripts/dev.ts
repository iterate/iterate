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
// Either way the server holds .wrangler/dev-server.lock from before its build until it exits (one
// per worktree: a second is refused, a second `start --detach` waits for the first), and is recorded
// in .wrangler/dev-server.json ({pid, port, baseUrl, startedAt, detached}) once `/version` answers —
// what `status`, `kill` and getin read. The record stays after the server stops: it is how a
// worktree keeps its port. Without `--port`, the port is this
// worktree's last recorded one, else 8788, else any free one — so two worktrees each keep their
// own, and the one that gets 8788 matches the Dash's documented `.dev.vars`
// (`ITERATE_ORIGIN=http://localhost:8788`).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { build } from "./build.ts";

const root = path.resolve(import.meta.dirname, "..");
const stateDir = path.join(root, ".wrangler");
const recordPath = path.join(stateDir, "dev-server.json");
const logPath = path.join(stateDir, "dev.log");
const lockPath = path.join(stateDir, "dev-server.lock");

const [command, ...rest] = process.argv.slice(2).filter((argument) => argument !== "--");
const commands: Record<string, (args: string[]) => Promise<void>> = {
  start: async (args) => {
    if (!args.includes("--detach")) return serve(args);
    const running = await runningServer();
    if (running) return console.log(`already running: ${describe(running)}`);
    await startDetached(args);
  },
  status: async () => {
    const running = await runningServer();
    if (running) return console.log(`running: ${describe(running)}`);
    const starting = holder();
    if (starting) {
      console.log(`starting (pid ${starting})`);
      process.exitCode = 1;
      return;
    }
    const last = readRecord();
    console.log(`not running${last ? ` (last on port ${last.port})` : ""}`);
    process.exitCode = 1;
  },
  attach: async () => {
    const running = await runningServer();
    if (running && !running.detached)
      throw new Error(`${describe(running)} runs attached: its output is in its own terminal`);
    if (!existsSync(logPath)) throw new Error(`no log at ${logPath}: \`pnpm dev start --detach\``);
    const pid = holder();
    console.error(
      pid
        ? `following pid ${pid} — Ctrl-C detaches, the server keeps running`
        : `not running; the last log:`,
    );
    // `tail -F` follows by inotify/kqueue, and on through a restart's truncation
    const tail = spawn("tail", ["-n", "100", ...(pid ? ["-F"] : []), logPath], {
      stdio: "inherit",
    });
    process.on("SIGINT", () => tail.kill("SIGINT"));
    await new Promise((resolve) => tail.on("exit", resolve));
  },
  kill: async () => {
    // a starting server too: the lock's holder, whether or not it answers yet
    const pid = holder();
    if (!pid) return console.log("not running");
    await stop(pid);
    console.log(`stopped pid ${pid}`);
  },
  restart: async (args) => {
    const pid = holder();
    if (pid) await stop(pid);
    // without --port, `defaultPort` takes the recorded one, free again
    await startDetached(args);
  },
  // the detached server itself: `startDetached` spawns this with an IPC channel
  serve: (args) => serve(args),
};
await (command && command in commands ? commands[command]!(rest) : serve(process.argv.slice(2)));

/** Run the server in this process's foreground: the lock, the build, `vite dev` as a child, the
 *  record once it answers. A detached one is handed the lock by `startDetached`, which hears
 *  "ready" over IPC. */
async function serve(argv: string[]) {
  const args = argv.filter((argument) => argument !== "--");
  if (process.send) {
    // detached: ask `startDetached` for the lock (asking, so its answer cannot beat our listener).
    // A launcher that dies first (`pnpm dev kill` signals the lock's pid — until the handover, the
    // launcher's) closes the channel: go with it, rather than wait forever unlocked.
    const orphaned = () => process.exit(1);
    process.once("disconnect", orphaned);
    const handed = new Promise((resolve) => process.once("message", resolve));
    process.send("lock?");
    await handed;
    process.off("disconnect", orphaned);
  } else {
    const held = acquire();
    if (held)
      throw new Error(
        `this worktree's dev server is already running or starting (pid ${held}): \`pnpm dev attach\` or \`pnpm dev kill\``,
      );
  }
  process.on("exit", () => {
    if (lockPid() === process.pid) rmSync(lockPath);
  });
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : await defaultPort();
  const viteArgs = portIndex >= 0 ? args : [...args, "--port", `${port}`];
  await build();
  // plain files have no compare-and-swap: a lock taken in the instant another process restored one
  // it moved aside (`holder`) is gone by now, and its taker stops here, before any workerd
  if (lockPid() !== process.pid)
    throw new Error(`another dev server took this worktree's lock (pid ${lockPid()})`);
  const vite = spawn("pnpm", ["exec", "vite", "dev", ...viteArgs], {
    cwd: root,
    env: { ...process.env, CLOUDFLARE_ENV: "", OS_DEV_PORT: `${port}` },
    stdio: ["inherit", "inherit", "inherit"],
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => vite.kill(signal));
  vite.on("exit", (code) => process.exit(process.exitCode ?? code ?? 0));
  const baseUrl = `http://localhost:${port}`;
  const outcome = await answers(baseUrl, vite);
  if (outcome === "exited") return;
  if (outcome === "timeout") {
    // stop vite (and its workerd) rather than leave it holding the port unrecorded; its exit ends
    // this process, and a detached launcher then fails with the log's tail
    console.error(`${baseUrl}/version did not answer within 3 minutes; stopping vite`);
    process.exitCode = 1;
    vite.kill("SIGTERM");
    return;
  }
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
  // the lock first, so a concurrent start (two `getin`s) waits here rather than racing to spawn
  const held = acquire();
  if (held) return console.log(`running: ${describe(await readied(held))}`);
  process.on("exit", () => {
    if (lockPid() === process.pid) rmSync(lockPath);
  });
  const log = openSync(logPath, "w");
  // process.execArgv carries tsx's loader (`--import …/tsx/…`), so the child runs this .ts file
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      import.meta.filename,
      "serve",
      // `start --detach` and a `restart --detach` alike: the rest is vite's
      ...args.filter((argument) => argument !== "--detach"),
    ],
    { cwd: root, detached: true, stdio: ["ignore", log, log, "ipc"] },
  );
  closeSync(log);
  console.log(`starting the dev server (pid ${child.pid}, log ${logPath}) …`);
  const outcome = await new Promise<{ ready: DevServer } | { exit: number | null }>((resolve) => {
    child.on("message", (message) => {
      if (message !== "lock?") return resolve(message as { ready: DevServer });
      // hand it the lock — an atomic replace — and say so: it builds only once it holds it
      const handover = `${lockPath}.${child.pid}`;
      writeFileSync(handover, `${child.pid}`);
      renameSync(handover, lockPath);
      child.send("lock");
    });
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

/** Take .wrangler/dev-server.lock, created exclusively (`wx`) before any build, so two servers
 *  cannot both start a workerd on this worktree's state — two `getin`s at once, say. null once
 *  taken; else the pid of the `serve` that holds it, starting or running. */
function acquire(): number | null {
  mkdirSync(stateDir, { recursive: true });
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = holder();
    if (held) return held;
  }
}

/** The pid of this worktree's `serve` — starting or running — from the lock, while that process is
 *  still a dev.ts. A lock a killed server left behind (SIGKILL runs no exit handler) is cleared
 *  rather than trusted with a pid the system may have reused — by compare-and-delete: moved aside
 *  atomically, and put back (an atomic replace) if what moved was a lock another process took
 *  meanwhile. Whoever that put-back displaces finds out in `serve`'s check after the build. */
function holder(): number | null {
  const pid = lockPid();
  if (pid === null) return null;
  // -ww: the full command line — a detached server's (node, tsx's loader flags, then this file's
  // absolute path) runs past the terminal's width, to which ps (macOS's, with COLUMNS) truncates
  const command = spawnSync("ps", ["-ww", "-o", "command=", "-p", `${pid}`], {
    encoding: "utf8",
  }).stdout;
  if (command.includes(path.join("scripts", "dev.ts"))) return pid;
  const aside = `${lockPath}.stale-${process.pid}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return holder(); // another process cleared it first
  }
  if (Number(readFileSync(aside, "utf8")) === pid) rmSync(aside);
  else renameSync(aside, lockPath);
  return holder();
}

function lockPid() {
  try {
    return Number(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

/** Wait for the server another `start --detach` is starting to answer — through its launcher
 *  handing the lock to it — or to give up. */
async function readied(pid: number) {
  console.log(`waiting for the dev server (pid ${pid}) to answer …`);
  for (;;) {
    const running = await runningServer();
    if (running) return running;
    if (!holder()) throw new Error("the dev server being started exited before answering");
    await sleep(500);
  }
}

/** SIGTERM the server — its process group when it leads one (a detached one does), else the
 *  process, whose `serve` forwards it to vite — then SIGKILL whatever of its process tree is left
 *  after 10s, and wait for it to be gone, so the next start finds the lock free. The tree is read
 *  first (`pgrep -P`, macOS's and procps's alike): an attached `pnpm dev` shares its terminal's
 *  group, and once it dies its vite and workerd are reparented out of reach. */
async function stop(pid: number) {
  const tree = [pid, ...descendants(pid)];
  const signal = (target: number, name: NodeJS.Signals) => {
    try {
      process.kill(target, name);
    } catch {
      // gone already, or (a negative target) no such group: an attached server's
    }
  };
  signal(-pid, "SIGTERM");
  signal(pid, "SIGTERM");
  const settled = async (ms: number) => {
    for (let waited = 0; waited < ms && tree.some(alive); waited += 200) await sleep(200);
  };
  await settled(10_000);
  for (const survivor of tree.filter(alive)) signal(survivor, "SIGKILL");
  await settled(5_000);
}

function descendants(pid: number): number[] {
  const children = spawnSync("pgrep", ["-P", `${pid}`], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number);
  return children.flatMap((child) => [child, ...descendants(child)]);
}

/** `/version` every 250ms until it answers, for up to 3 minutes (the first `vite dev` optimizes
 *  dependencies), or until vite exits. */
async function answers(baseUrl: string, vite: ChildProcess) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null || vite.signalCode) return "exited";
    const response = await version(baseUrl);
    if (response?.ok) return "ready";
    await sleep(250);
  }
  return "timeout";
}

type DevServer = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: string;
  /** started by `start --detach`: its output is in the log */
  detached: boolean;
};

/** The recorded server, when it still holds the lock and answers `/version` (not some other
 *  process that inherited the pid or the port). */
async function runningServer() {
  const record = readRecord();
  if (!record || record.pid !== holder()) return null;
  const response = await version(record.baseUrl);
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

/** `GET /version`, null when it fails or takes over 5s: a server that accepts and never answers
 *  must not hang a deadline, `status` or `getin`. */
function version(baseUrl: string) {
  return fetch(`${baseUrl}/version`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
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
