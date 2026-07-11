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

/** Call the mount over the FULL agent path (`itx.<name>.__ping()`) — the same route an agent uses. */
function pingMount(itx: RpcStub<Project>, name: string): Promise<{ ok: true }> {
  return (itx as unknown as Record<string, { __ping(): Promise<{ ok: true }> }>)[name].__ping();
}

/**
 * Keep the live mount routable for as long as we run, and never return. A live
 * capability's provider ref lives only in the capability-host DO's memory, so a
 * DO eviction or a dropped socket silently takes it "offline" while this process
 * keeps happily running. So we don't just heartbeat — every few seconds we
 * self-call the mount over the full agent path: that round-trip keeps the host
 * DO warm AND proves the mount still answers. If it doesn't, we re-provide on the
 * current socket (recovers a DO eviction that dropped the ref but left our
 * connection intact); if THAT fails the connection is dead, so we reconnect and
 * provide fresh. `onReprovided` fires whenever we had to re-establish it.
 */
async function keepMountAlive(input: {
  itx: RpcStub<Project>;
  connect: ConnectInput;
  name: string;
  capability: typeof myComputer;
  onReprovided?: () => void;
}): Promise<never> {
  let itx = input.itx;
  const provide = (stub: RpcStub<Project>) =>
    stub.provideCapability({
      type: "live",
      path: [input.name],
      capability: input.capability,
      instructions: INSTRUCTIONS,
      types: TYPES,
    });
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
    try {
      await pingMount(itx, input.name);
      continue; // mount answered — still live
    } catch {
      // Mount not answering: re-provide on the current socket, else reconnect.
      try {
        await provide(itx);
      } catch {
        itx = await connectAndProvide(input.connect, input.name, input.capability);
      }
      input.onReprovided?.();
    }
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
