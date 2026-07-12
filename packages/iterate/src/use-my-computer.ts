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

/**
 * The object we lend to the project. Each method becomes callable by agents as
 * `itx.myComputer.<method>(...)`. capnweb ships the *call* over this process's
 * socket, so the body runs locally — native macOS dialogs and all.
 */
const myComputer = {
  /** Pop a native dialog on screen and return which button the human clicked. */
  async ask({ question, buttons = ["No", "Yes"] }: { question: string; buttons?: string[] }) {
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
  },

  /** Show a desktop notification. */
  async notify({ message, title = "iterate" }: { message: string; title?: string }) {
    await osascript(
      `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"`,
    );
    return { ok: true as const };
  },

  /** Run arbitrary Swift and return its output — full power, when an agent needs it. */
  async runSwift({ code }: { code: string }) {
    // `swift -` reads a whole program from stdin and runs it.
    return await run("swift", ["-"], code);
  },

  /**
   * Lend a server running on this machine to the project: returns
   * `{ fetch(request) }` that proxies each request to
   * `http://127.0.0.1:<port>`. A project worker's homepage can literally be
   * `return (await itx.myComputer.getFetcher({ port })).fetch(req)` — the
   * Request rides capability dispatch here, the fetch happens on this Mac,
   * and the Response rides back. Plain HTTP only: capability dispatch is RPC,
   * and a socket-carrying Response cannot cross workerd's internal hops
   * (apps/os/docs/dynamic-worker-dispatch.md) — WebSocket upgrades get a
   * teaching error pointing at connectSocket.
   */
  async getFetcher({ port, host = "127.0.0.1" }: { port: number; host?: string }) {
    const origin = `http://${host}:${port}`;
    return { fetch: (request: Request) => proxyLocalHttp(origin, request) };
  },

  /**
   * The WebSocket lane getFetcher cannot offer: open a real socket to a server
   * on this machine and bridge FRAMES over capability dispatch. Returns a
   * bridge — `send(data)` pushes a frame to the local server, `close()` hangs
   * up — while incoming frames (and the eventual close) reach the `onMessage` /
   * `onClose` callbacks. The socket can never cross the RPC mesh, so a Durable
   * Object app terminates the browser's WebSocket with WebSocketPair and pumps
   * frames both ways through this bridge. See `openSocketBridge` for the
   * ownership/teardown contract.
   */
  async connectSocket(input: {
    port: number;
    path?: string;
    host?: string;
    onMessage?: (data: string) => unknown;
    onClose?: (info: { code: number; reason: string }) => unknown;
  }) {
    return await openSocketBridge(input);
  },
};

/**
 * The exact provideCapability input `iterate use-my-computer` sends — exported
 * so the e2e suite provides the REAL capability (object, instructions, types)
 * from its own process and proves the fetcher + socket bridge end to end
 * (apps/os/e2e/vitest/live-capability-fetcher.e2e.test.ts).
 */
export function myComputerProvision(name: string) {
  return {
    type: "live" as const,
    path: [name],
    capability: myComputer,
    instructions: INSTRUCTIONS,
    types: TYPES,
  };
}

/** Prose + a type signature so agents (and `__describe()`) know how to call this. */
const INSTRUCTIONS = `A real person's Mac, shared live from their terminal for as long as \`iterate use-my-computer\` runs.
- ask({ question, buttons? }) pops a native dialog on their screen and returns { answer } — the button they clicked. Perfect for a quick human yes/no or choice.
- notify({ message, title? }) shows a desktop notification.
- runSwift({ code }) runs Swift on their Mac and returns { stdout, stderr, exitCode }. It has full access to their files, GUI and network, so ask before doing anything destructive.
- getFetcher({ port }) lends a server running on their machine: the returned { fetch } proxies each Request to http://127.0.0.1:<port> on their Mac and returns the Response. A worker's fetch handler can forward straight through — e.g. \`return (await itx.myComputer.getFetcher({ port: 3000 })).fetch(req)\` serves their local dev server on a project host. HTTP only; WebSocket upgrades throw a teaching error.
- connectSocket({ port, path?, onMessage?, onClose? }) opens a real WebSocket to a local server and bridges FRAMES over this capability: onMessage receives each incoming frame, and the returned bridge has send(data) and close(). Terminate the browser's socket in a Durable Object app and pump frames through this bridge — the socket itself can never cross RPC.`;

// A capability `types` string must be a valid TS declaration named `Capability`
// (the egress/capability host typechecks it before mounting) — not a bare object
// literal, which fails to compile and aborts the mount.
const TYPES = `export type Capability = {
  ask(input: { question: string; buttons?: string[] }): Promise<{ answer: string }>;
  notify(input: { message: string; title?: string }): Promise<{ ok: true }>;
  runSwift(input: { code: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  getFetcher(input: { port: number; host?: string }): Promise<{ fetch(request: Request): Promise<Response> }>;
  connectSocket(input: {
    port: number;
    path?: string;
    host?: string;
    onMessage?: (data: string) => unknown;
    onClose?: (info: { code: number; reason: string }) => unknown;
  }): Promise<{
    send(data: string): Promise<{ ok: true }>;
    close(input?: { code?: number; reason?: string }): Promise<{ ok: true }>;
  }>;
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
function agentPrompt(name: string): string {
  const kind = /macbook/i.test(hostname())
    ? "a MacBook"
    : process.platform === "darwin"
      ? "a Mac"
      : "their computer";
  const owner = /^(.+?)(computer|mac|laptop|machine)$/i.exec(name)?.[1];
  const whose = owner ? `${owner[0].toUpperCase()}${owner.slice(1)}’s computer` : name;
  return [
    "📋 Paste this to an agent so it knows it can use your computer:",
    "",
    `   By the way, you can use \`itx.${name}\` to interact with ${whose} (${kind}).`,
    `   Call \`itx.${name}.__describe()\` first to learn how it works — it can ask you`,
    `   questions with native dialogs, send notifications, run Swift, and lend`,
    `   local servers (getFetcher/connectSocket proxy HTTP and WebSockets to a port).`,
  ].join("\n");
}

type ConnectInput = {
  auth: ItxAuthCredentials;
  baseUrl: string;
  projectId: string;
  headers?: Record<string, string>;
  name?: string;
};

/** Mount `capability` at `itx.<name>` and return the live socket stub. */
async function connectAndProvide(
  input: ConnectInput,
  name: string,
  capability: typeof myComputer,
): Promise<RpcStub<Project>> {
  const itx = connectItx({
    auth: input.auth,
    baseUrl: input.baseUrl,
    projectId: input.projectId,
    headers: input.headers,
  }) as RpcStub<Project>;

  await itx.provideCapability({ ...myComputerProvision(name), capability });
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
  const itx = await connectAndProvide(input, name, myComputer);
  log(`✅ itx.${name} is live for project ${input.projectId}. Press Ctrl-C to stop sharing.\n`);
  log(agentPrompt(name));
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
  const itx = await connectAndProvide(input, name, withActivity(myComputer));
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
function withActivity(capability: typeof myComputer): typeof myComputer {
  let nextId = 0;
  // Each capability method takes exactly one argument and announces itself as
  // it runs. The returned transport handles (getFetcher's { fetch }, the frame
  // bridge) pass through untouched: per-request activity would mean reflecting
  // over their methods, which changes what capnweb serializes back — the
  // top-level getFetcher/connectSocket line is enough to show the computer's
  // in use.
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
  const wrapped = {} as Record<string, (arg: never) => Promise<unknown>>;
  for (const [method, fn] of Object.entries(capability)) {
    wrapped[method] = announce(method, fn);
  }
  return wrapped as typeof myComputer;
}

/** A short, human-readable line describing one call — for the app's activity log. */
function summarizeCall(method: string, arg: unknown): string {
  const input = (arg ?? {}) as {
    question?: string;
    message?: string;
    code?: string;
    port?: number;
    path?: string;
  };
  if (method === "ask") return truncate(input.question ?? "asked a question");
  if (method === "notify") return truncate(input.message ?? "sent a notification");
  if (method === "runSwift") {
    const lines = (input.code ?? "").split("\n").filter((line) => line.trim() !== "").length;
    return `ran ${lines} line${lines === 1 ? "" : "s"} of Swift`;
  }
  if (method === "getFetcher") return `lent an HTTP fetcher to localhost:${input.port}`;
  if (method === "connectSocket") {
    return `opened a WebSocket to localhost:${input.port}${input.path ?? "/"}`;
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
