// ─────────────────────────────────────────────────────────────────────────────
// `iterate use-my-computer` — lend your laptop to a project's AI agents.
//
// The whole idea in three sentences:
//   1. You open one WebSocket to your Iterate project and "provide" a capability
//      called `myComputer` onto it.
//   2. From then on, any agent in that project can call `itx.myComputer.ask(...)`,
//      `itx.myComputer.notify(...)` or `itx.myComputer.runSwift(...)`.
//   3. Because it's a *live* capability, the agent's call travels back down your
//      WebSocket and the code runs right here — on your Mac, as you, with your
//      screen, files and network. There is no server-side sandbox in between.
//
// That's the trick: `provideCapability({ type: "live", capability })` hands the
// project a remote reference to a plain JavaScript object. Calls to it are RPCs
// that come home to this process. Everything below is just (a) that object and
// (b) keeping the socket alive so agents can reach it.
//
// Two front-ends ride the same core: the terminal command (shareMyComputer,
// prints a paste-for-your-agent hint) and the machine one the menu-bar app
// drives (runUseMyComputerJson) — the latter wraps the capability so every agent
// call announces itself as NDJSON, which is how the app shows "in use".
// ─────────────────────────────────────────────────────────────────────────────

import { hostname } from "node:os";

import * as prompts from "@clack/prompts";
import type { RpcStub } from "capnweb";

import { connectItx } from "../../../apps/os/src/itx-client.ts";
import type { ItxAuthCredentials, Project } from "./itx-api.generated.ts";
import { run } from "./run-command.ts";
import { closeAllBridges, openSocketBridge, proxyLocalHttp } from "./use-my-computer-transport.ts";

// The methods we lend to the project. Each becomes callable by agents as
// `itx.<name>.<method>(...)`; capnweb ships the *call* over this process's
// socket, so the body runs locally — native macOS dialogs and all.

/** Pop a native dialog on screen and return which button the human clicked. */
async function ask({
  question,
  buttons = ["No", "Yes"],
}: {
  question: string;
  buttons?: string[];
}) {
  // AppleScript's `display dialog` supports one to three buttons.
  if (buttons.length < 1 || buttons.length > 3) {
    throw new Error("ask() needs 1–3 buttons (AppleScript dialogs cap at three).");
  }
  const buttonList = buttons.map((b) => `"${escapeForAppleScript(b)}"`).join(", ");
  const { stdout } = await osascript(
    `display dialog "${escapeForAppleScript(question)}" ` +
      `buttons {${buttonList}} default button "${escapeForAppleScript(buttons.at(-1)!)}" ` +
      `with title "iterate · myComputer"`,
  );
  // osascript prints e.g. `button returned:Yes` — hand back just the choice.
  return { answer: stdout.trim().replace(/^button returned:/, "") };
}

/** Show a desktop notification. */
async function notify({ message, title = "iterate" }: { message: string; title?: string }) {
  await osascript(
    `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"`,
  );
  return { ok: true as const };
}

/** Run arbitrary Swift and return its output — full power, when an agent needs it. */
async function runSwift({ code }: { code: string }) {
  // `swift -` reads a whole program from stdin and runs it.
  return await run("swift", ["-"], code);
}

/** The human-interaction methods, always present — callable as itx.<name>.<method>(). */
const baseMethods = { ask, notify, runSwift };

/**
 * Lend the server on ONE local port as a URL origin. These are the PLATFORM's
 * to call, not agents': a project reaches them by URL —
 * `fetch("http://<name>.iterate/…", req)` — never `itx.<name>.fetch(...)`.
 * - fetch(request) proxies each request to http://127.0.0.1:<port>.
 * - connectSocket({ path, onMessage, onClose }) opens a real WebSocket to the
 *   local server and bridges FRAMES; the capability host terminates the
 *   browser's socket (WebSocketPair) and pumps frames through this handle,
 *   because the socket itself can never cross an RPC hop.
 */
function addressableOrigin(port: number, host = "127.0.0.1") {
  const origin = `http://${host}:${port}`;
  return {
    fetch: (request: Request) => proxyLocalHttp(origin, request),
    connectSocket: (input: {
      path?: string;
      onMessage?: (data: string) => unknown;
      onClose?: (info: { code: number; reason: string }) => unknown;
    }) => openSocketBridge({ ...input, port, host }),
  };
}

/**
 * The object `iterate use-my-computer` lends. With `exposePort`, it also lends
 * the server on that local port as an addressable URL origin (HTTP + WebSocket).
 */
export function createMyComputer(options: { exposePort?: number } = {}) {
  return options.exposePort === undefined
    ? { ...baseMethods }
    : { ...baseMethods, ...addressableOrigin(options.exposePort) };
}

export type MyComputer = ReturnType<typeof createMyComputer>;

/**
 * The exact provideCapability input `iterate use-my-computer` sends — exported
 * so the e2e suite provides the REAL capability (object, instructions, types)
 * from its own process and proves URL addressing end to end
 * (apps/os/e2e/vitest/live-capability-fetcher.e2e.test.ts). `exposePort` makes
 * the mount `addressable` and lends that local port at http://<name>.iterate/.
 */
export function myComputerProvision(name: string, options: { exposePort?: number } = {}) {
  return {
    type: "live" as const,
    path: [name],
    capability: createMyComputer(options),
    addressable: options.exposePort !== undefined,
    instructions: instructionsFor(name, options.exposePort !== undefined),
    types: TYPES,
  };
}

/** Prose so agents (and `__describe()`) know how to drive this. */
function instructionsFor(name: string, addressable: boolean): string {
  const base = `A real person's Mac, shared live from their terminal for as long as \`iterate use-my-computer\` runs.
- ask({ question, buttons? }) pops a native dialog on their screen and returns { answer } — the button they clicked. Perfect for a quick human yes/no or choice.
- notify({ message, title? }) shows a desktop notification.
- runSwift({ code }) runs Swift on their Mac and returns { stdout, stderr, exitCode }. It has full access to their files, GUI and network, so ask before doing anything destructive.`;
  if (!addressable) return base;
  const url = `http://${name.toLowerCase()}.iterate`;
  return `${base}

This computer also lends a local server, reachable by URL (not by an itx method): fetch \`${url}/…\` from a project worker. A worker's fetch handler can forward straight through — \`const u = new URL(req.url); return fetch(new Request("${url}" + u.pathname + u.search, req));\` serves their local dev server on a project host. Unlike the itx RPC path, the URL carries WebSocket upgrades (HMR, live reload) too.`;
}

// A capability `types` string must be a valid TS declaration named `Capability`
// (the capability host typechecks it before mounting) — not a bare object
// literal, which fails to compile and aborts the mount. The addressable origin
// (fetch/connectSocket) is reached by URL, not as an itx method, so it is
// described in the instructions above rather than declared here.
const TYPES = `export type Capability = {
  ask(input: { question: string; buttons?: string[] }): Promise<{ answer: string }>;
  notify(input: { message: string; title?: string }): Promise<{ ok: true }>;
  runSwift(input: { code: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
};`;

/**
 * Ask what agents should call this computer, and mount the capability there —
 * e.g. answering "jonasComputer" makes it `itx.jonasComputer`. We propose a
 * camelCase name from the hostname; the human can accept it or type their own.
 */
async function askComputerName(): Promise<string> {
  const proposed = proposeComputerName();
  // Non-interactive (piped output, an agent): just take the proposal.
  if (!process.stdin.isTTY) return proposed;

  const answer = await prompts.text({
    message: "What should agents call this computer? (camelCase — it becomes the itx.<name> path)",
    placeholder: proposed,
    defaultValue: proposed,
    validate: (value) =>
      /^[a-zA-Z][a-zA-Z0-9]*$/.test((value ?? "").trim())
        ? undefined
        : "Use a camelCase name: letters and digits, starting with a letter (e.g. jonasComputer).",
  });
  if (prompts.isCancel(answer)) {
    prompts.cancel("Cancelled.");
    process.exit(0);
  }
  return answer.trim();
}

/**
 * Optionally lend a local server (a dev server, an API) at the capability's URL.
 * Blank skips it; a port number makes the mount addressable at
 * http://<name>.iterate/. Non-interactive callers pass `exposePort` explicitly.
 */
async function askExposePort(): Promise<number | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const answer = await prompts.text({
    message:
      "Lend a local server too? Enter its port (or leave blank) — reachable at http://<name>.iterate/",
    placeholder: "",
    defaultValue: "",
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (trimmed === "") return undefined;
      const port = Number(trimmed);
      return /^\d+$/.test(trimmed) && port > 0 && port < 65536
        ? undefined
        : "Enter a port number 1–65535, or leave blank to skip.";
    },
  });
  if (prompts.isCancel(answer)) {
    prompts.cancel("Cancelled.");
    process.exit(0);
  }
  const trimmed = answer.trim();
  return trimmed === "" ? undefined : Number(trimmed);
}

/** "Jonas’s-MacBook-Pro.local" → "jonasComputer". A friendly default, always editable. */
function proposeComputerName(): string {
  const firstWord = hostname()
    .replace(/\.local$/i, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)[0];
  const cleaned = firstWord?.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned ? `${cleaned}Computer` : "myComputer";
}

/**
 * A line the human can paste to an agent so it knows this capability exists.
 * `itx.<name>.__describe()` then teaches the agent exactly how to drive it.
 */
function agentPrompt(name: string, addressable: boolean): string {
  const kind = /macbook/i.test(hostname())
    ? "a MacBook"
    : process.platform === "darwin"
      ? "a Mac"
      : "their computer";
  const owner = /^(.+?)(computer|mac|laptop|machine)$/i.exec(name)?.[1];
  const whose = owner ? `${owner[0].toUpperCase()}${owner.slice(1)}’s computer` : name;
  const lines = [
    "📋 Paste this to an agent so it knows it can use your computer:",
    "",
    `   By the way, you can use \`itx.${name}\` to interact with ${whose} (${kind}).`,
    `   Call \`itx.${name}.__describe()\` first to learn how it works — it can ask you`,
    `   questions with native dialogs, send notifications, and run Swift.`,
  ];
  if (addressable) {
    lines.push(
      `   It also serves a local server at http://${name.toLowerCase()}.iterate/ — a worker can`,
      `   \`return fetch("http://${name.toLowerCase()}.iterate/", req)\` to show it (HTTP + WebSockets).`,
    );
  }
  return lines.join("\n");
}

type ConnectInput = {
  auth: ItxAuthCredentials;
  baseUrl: string;
  projectId: string;
  headers?: Record<string, string>;
  name?: string;
  /** Also lend the local server on this port at http://<name>.iterate/. */
  exposePort?: number;
};

/** Mount the capability at `itx.<name>` and return the live socket stub. */
async function connectAndProvide(
  input: ConnectInput,
  name: string,
  options: { exposePort?: number; wrapActivity?: boolean },
): Promise<RpcStub<Project>> {
  const provision = myComputerProvision(name, { exposePort: options.exposePort });
  const capability = options.wrapActivity
    ? withActivity(provision.capability)
    : provision.capability;
  const itx = connectItx({
    auth: input.auth,
    baseUrl: input.baseUrl,
    projectId: input.projectId,
    headers: input.headers,
  }) as RpcStub<Project>;

  await itx.provideCapability({ ...provision, capability });
  return itx;
}

/**
 * Keep the mount routable — a live capability only serves while its socket is
 * warm — and never return. When the CLI's own socket to OS drops, every mounted
 * capability is unreachable, so close any open frame bridges to release their
 * local sockets. `onRpcBroken` is the authoritative disconnect signal; the
 * heartbeat only keeps the mount warm and ignores individual failures (a
 * transient `__describe` hiccup must not tear down live bridges).
 */
function holdWarm(itx: RpcStub<Project>): Promise<never> {
  (itx as { onRpcBroken?(handler: (error: unknown) => void): void }).onRpcBroken?.(() =>
    closeAllBridges(),
  );
  const heartbeat = () => itx.__describe().catch(() => {});
  heartbeat();
  setInterval(heartbeat, 5_000);
  return new Promise<never>(() => {});
}

/**
 * Ask for a name, provide `itx.<name>`, and hold the line until Ctrl-C. Never
 * returns; the caller runs it as the body of a long-lived command.
 */
export async function shareMyComputer(
  input: ConnectInput & { log?: (message: string) => void },
): Promise<never> {
  const log = input.log ?? ((message: string) => console.error(message));
  const name = input.name ?? (await askComputerName());
  const exposePort = input.exposePort ?? (await askExposePort());
  const itx = await connectAndProvide(input, name, { exposePort });
  log(`✅ itx.${name} is live for project ${input.projectId}. Press Ctrl-C to stop sharing.\n`);
  log(agentPrompt(name, exposePort !== undefined));
  return holdWarm(itx);
}

/**
 * The machine front-end the menu-bar app drives. Same live mount, but the
 * capability is wrapped so every agent call announces itself as NDJSON on
 * stdout — that stream is how the app shows the computer being used.
 *
 * Out (stdout):
 *   {"type":"status","loggedIn":true,"project":"prj_…","name":"jonasComputer"}
 *   {"type":"call","id":1,"method":"ask","summary":"Deploy to prod?","at":"…"}
 *   {"type":"call-done","id":1,"method":"ask","ok":true,"ms":1234}
 */
export async function runUseMyComputerJson(input: ConnectInput): Promise<never> {
  const name = input.name ?? proposeComputerName();
  const itx = await connectAndProvide(input, name, {
    exposePort: input.exposePort,
    wrapActivity: true,
  });
  emitJson({ type: "status", loggedIn: true, project: input.projectId, name });
  // If the menu-bar parent goes away, stdin closes — stop sharing rather than
  // leaving the computer silently lent with no window onto it.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
  return holdWarm(itx);
}

/** One NDJSON line to stdout — the machine protocol's only output channel. */
function emitJson(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** Emitted (and the process exits) when there is no usable session yet. */
export function emitComputerNeedsLogin(): void {
  emitJson({ type: "status", loggedIn: false });
}

/**
 * Wrap each capability method so it emits `call` before running and `call-done`
 * after — the menu-bar app reads these to show which agent action is live. The
 * behaviour is otherwise identical: the wrapped method awaits the real one and
 * returns (or rethrows) exactly what it did.
 */
/** Methods worth surfacing in the menu-bar activity log — the human actions.
 * The addressable origin (fetch/connectSocket) is high-frequency transport and
 * passes through unannounced. */
const ANNOUNCED_METHODS = new Set(["ask", "notify", "runSwift"]);

function withActivity(capability: MyComputer): MyComputer {
  let nextId = 0;
  const announce = (method: string, fn: (arg: never) => Promise<unknown>) => {
    return async (arg: never) => {
      const id = (nextId += 1);
      emitJson({
        type: "call",
        id,
        method,
        summary: summarizeCall(method, arg),
        at: new Date().toISOString(),
      });
      const startedAt = Date.now();
      try {
        const result = await fn(arg);
        emitJson({ type: "call-done", id, method, ok: true, ms: Date.now() - startedAt });
        return result;
      } catch (error) {
        emitJson({
          type: "call-done",
          id,
          method,
          ok: false,
          ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  };
  // Announce the human actions; pass the addressable origin's fetch/connectSocket
  // through untouched (announcing every proxied request would flood the log).
  const wrapped: Record<string, unknown> = { ...capability };
  for (const [method, fn] of Object.entries(capability)) {
    if (ANNOUNCED_METHODS.has(method) && typeof fn === "function") {
      wrapped[method] = announce(method, fn as (arg: never) => Promise<unknown>);
    }
  }
  return wrapped as MyComputer;
}

/** A short, human-readable line describing one call — for the app's activity log. */
function summarizeCall(method: string, arg: unknown): string {
  const input = (arg ?? {}) as { question?: string; message?: string; code?: string };
  if (method === "ask") return truncate(input.question ?? "asked a question");
  if (method === "notify") return truncate(input.message ?? "sent a notification");
  if (method === "runSwift") {
    const lines = (input.code ?? "").split("\n").filter((line) => line.trim() !== "").length;
    return `ran ${lines} line${lines === 1 ? "" : "s"} of Swift`;
  }
  return method;
}

const truncate = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

// ── tiny local helpers ───────────────────────────────────────────────────────

/** Run an AppleScript snippet, throwing if osascript reports failure (e.g. the human cancels). */
async function osascript(script: string) {
  const result = await run("osascript", ["-e", script]);
  if (result.exitCode !== 0) {
    throw new Error(
      `osascript failed (exit ${result.exitCode}): ${result.stderr.trim() || "no output"}`,
    );
  }
  return result;
}

/** Escape a string for embedding in an AppleScript double-quoted literal. */
const escapeForAppleScript = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
