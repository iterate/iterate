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
   * A liveness probe, deliberately absent from the declared types so agents
   * never see it. The provider self-calls it over the full agent path to keep
   * the capability-host warm and detect a dropped mount — see keepMountAlive.
   */
  async ["__ping"]() {
    return { ok: true as const };
  },
};

/** Prose + a type signature so agents (and `__describe()`) know how to call this. */
const INSTRUCTIONS = `A real person's Mac, shared live from their terminal for as long as \`iterate use-my-computer\` runs.
- ask({ question, buttons? }) pops a native dialog on their screen and returns { answer } — the button they clicked. Perfect for a quick human yes/no or choice.
- notify({ message, title? }) shows a desktop notification.
- runSwift({ code }) runs Swift on their Mac and returns { stdout, stderr, exitCode }. It has full access to their files, GUI and network, so ask before doing anything destructive.`;

// A capability `types` string must be a valid TS declaration named `Capability`
// (the egress/capability host typechecks it before mounting) — not a bare object
// literal, which fails to compile and aborts the mount.
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
      /^[a-zA-Z][a-zA-Z0-9]*$/.test(value.trim())
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
    `   questions with native dialogs, send notifications, and run Swift.`,
  ].join("\n");
}

/** Freshly-resolved credentials for one (re)connect. */
type ResolvedAuth = { auth: ItxAuthCredentials; headers?: Record<string, string> };

type ConnectInput = {
  baseUrl: string;
  projectId: string;
  name?: string;
  /**
   * Re-resolve (and refresh) credentials — called before EVERY (re)connect. The
   * OS access token has a short (~15-minute) TTL, so a reconnect that reused the
   * token captured at launch would fail once it expires; re-resolving picks up a
   * refreshed token so extended sharing survives reconnects.
   */
  reauth: () => Promise<ResolvedAuth>;
};

/** Mount `capability` at `itx.<name>` with freshly-resolved auth and return the live socket stub. */
async function connectAndProvide(
  input: ConnectInput,
  name: string,
  capability: typeof myComputer,
): Promise<RpcStub<Project>> {
  const { auth, headers } = await input.reauth();
  const itx = connectItx({
    auth,
    baseUrl: input.baseUrl,
    projectId: input.projectId,
    headers,
  }) as RpcStub<Project>;

  await itx.provideCapability({
    type: "live",
    path: [name],
    capability,
    instructions: INSTRUCTIONS,
    types: TYPES,
  });
  return itx;
}

const HEALTH_CHECK_INTERVAL_MS = 8_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
// A reconnect includes connectItx's WebSocket handshake (up to ~15s), so this
// backstop sits ABOVE that — otherwise a handshake that would have succeeded is
// abandoned mid-flight. connectItx's own handshake timeout rejects a dead
// endpoint well before this fires, so recoveries never overlap.
const RECONNECT_TIMEOUT_MS = 30_000;
const RECOVERY_BACKOFF_MS = 3_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Race a promise against a timeout so a STALLED RPC (a wedged connection that
 * never errors) is treated as a failure instead of hanging forever. The
 * abandoned work is caught so a rejection that lands after the timeout can't
 * surface as an unhandled rejection.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Best-effort close of a capnweb session's socket, so recoveries don't leak connections. */
function disposeItx(itx: RpcStub<Project>): void {
  try {
    (itx as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  } catch {
    // already gone
  }
}

/** Call the mount over the FULL agent path (`itx.<name>.__ping()`) — the same route an agent uses. */
function pingMount(itx: RpcStub<Project>, name: string): Promise<void> {
  const ping = (itx as unknown as Record<string, { __ping(): Promise<{ ok: true }> }>)[
    name
  ].__ping();
  return withTimeout(ping, HEALTH_CHECK_TIMEOUT_MS, "mount ping").then(() => {});
}

/**
 * Keep the live mount routable for as long as we run, and NEVER return. A live
 * capability's provider ref lives only in the capability-host DO's memory, so a
 * DO eviction or a dropped socket silently takes it "offline" while this process
 * keeps happily running. So we don't just heartbeat — we self-call the mount
 * over the full agent path: that round-trip keeps the host DO warm AND proves it
 * still answers. The first check runs right after the initial provide (no dead
 * startup window); thereafter every few seconds.
 *
 * When a check fails (eviction, a dropped or wedged socket, a deploy) we
 * reconnect FRESH — a new connection, with re-resolved auth so a reconnect past
 * the short access-token TTL still authenticates — provide again, and dispose the
 * old session. Recovery NEVER escapes the loop: a share session ends only when
 * the process does, so a failed round keeps the old stub, backs off, and retries
 * on the next tick. `onReprovided` fires whenever we re-establish it.
 */
async function keepMountAlive(input: {
  itx: RpcStub<Project>;
  connect: ConnectInput;
  name: string;
  capability: typeof myComputer;
  onReprovided?: () => void;
}): Promise<never> {
  let itx = input.itx;
  while (true) {
    try {
      await pingMount(itx, input.name); // confirms the mount end-to-end + keeps the host warm
    } catch {
      // The mount isn't answering. Reconnect fresh (bounded above the handshake
      // window); on failure keep the old stub, back off, and retry next tick —
      // this must never throw out of the loop.
      let fresh: RpcStub<Project> | undefined;
      try {
        fresh = await withTimeout(
          connectAndProvide(input.connect, input.name, input.capability),
          RECONNECT_TIMEOUT_MS,
          "reconnect",
        );
      } catch {
        // couldn't recover this round (transient network / auth / endpoint down)
      }
      if (fresh === undefined) {
        await sleep(RECOVERY_BACKOFF_MS);
        continue;
      }
      disposeItx(itx); // replace and free the old session
      itx = fresh;
      input.onReprovided?.();
    }
    await sleep(HEALTH_CHECK_INTERVAL_MS);
  }
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
  return keepMountAlive({
    itx,
    connect: input,
    name,
    capability: myComputer,
    onReprovided: () => log(`↻ re-shared itx.${name} after the mount dropped.`),
  });
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
  const capability = withActivity(myComputer);
  const itx = await connectAndProvide(input, name, capability);
  const status = () => emitJson({ type: "status", loggedIn: true, project: input.projectId, name });
  status();
  // If the menu-bar parent goes away, stdin closes — stop sharing rather than
  // leaving the computer silently lent with no window onto it.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
  // Re-emit status on every re-establish so the app knows it's still live.
  return keepMountAlive({ itx, connect: input, name, capability, onReprovided: status });
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
  const wrapped = {} as Record<string, (arg: never) => Promise<unknown>>;
  for (const [method, fn] of Object.entries(capability)) {
    // Internal probes (e.g. __ping) pass through unwrapped — they're not agent
    // activity and must not spam the NDJSON stream every health check.
    if (method.startsWith("__")) {
      wrapped[method] = fn as (arg: never) => Promise<unknown>;
      continue;
    }
    wrapped[method] = async (arg: never) => {
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
  }
  return wrapped as typeof myComputer;
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
