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
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { hostname } from "node:os";

import * as prompts from "@clack/prompts";
import type { RpcStub } from "capnweb";

import { connectItx } from "../../../apps/os/src/itx-client.ts";
import type { ItxAuthCredentials, Project } from "./itx-api.generated.ts";

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
};

/** Prose + a type signature so agents (and `__describe()`) know how to call this. */
const INSTRUCTIONS = `A real person's Mac, shared live from their terminal for as long as \`iterate use-my-computer\` runs.
- ask({ question, buttons? }) pops a native dialog on their screen and returns { answer } — the button they clicked. Perfect for a quick human yes/no or choice.
- notify({ message, title? }) shows a desktop notification.
- runSwift({ code }) runs Swift on their Mac and returns { stdout, stderr, exitCode }. It has full access to their files, GUI and network, so ask before doing anything destructive.`;

const TYPES = `{
  ask(input: { question: string; buttons?: string[] }): Promise<{ answer: string }>;
  notify(input: { message: string; title?: string }): Promise<{ ok: true }>;
  runSwift(input: { code: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}`;

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

/**
 * Ask for a name, provide `itx.<name>`, and hold the line until Ctrl-C.
 *
 * A live mount only routes while its socket is warm, so we send a small
 * heartbeat to keep it hot. Never returns; the caller runs it as the body of a
 * long-lived command.
 */
export async function shareMyComputer(input: {
  auth: ItxAuthCredentials;
  baseUrl: string;
  projectId: string;
  headers?: Record<string, string>;
  name?: string;
  log?: (message: string) => void;
}): Promise<never> {
  const log = input.log ?? ((message: string) => console.error(message));
  const name = input.name ?? (await askComputerName());

  const itx = connectItx({
    auth: input.auth,
    baseUrl: input.baseUrl,
    projectId: input.projectId,
    headers: input.headers,
  }) as RpcStub<Project>;

  await itx.provideCapability({
    type: "live",
    path: [name],
    capability: myComputer,
    instructions: INSTRUCTIONS,
    types: TYPES,
  });
  log(`✅ itx.${name} is live for project ${input.projectId}. Press Ctrl-C to stop sharing.\n`);
  log(agentPrompt(name));

  // A live mount only routes while its socket is warm, so ping now and then to
  // keep it hot (ignoring transient errors), and hold open until Ctrl-C.
  const heartbeat = () => itx.__describe().catch(() => {});
  heartbeat();
  setInterval(heartbeat, 5_000);
  return new Promise<never>(() => {});
}

// ── tiny local helpers ───────────────────────────────────────────────────────

/** Spawn a command, optionally feed it stdin, and collect its result. */
function run(command: string, args: string[], stdin?: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    // A signal-killed child reports a null code; surface that as a failure, not 0.
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

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
