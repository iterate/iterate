import { hostname } from "node:os";
import * as prompts from "@clack/prompts";
import { RpcTarget } from "capnweb";
import { run } from "./run-command.ts";
import type { connectIterate } from "./node.ts";

type ComputerEvent =
  | { type: "status"; loggedIn: true; name: string }
  | { type: "call"; id: number; method: string; summary: string }
  | { type: "call-done"; id: number; ok: boolean };

/** Methods run locally with the authority of the person sharing this Mac. */
export class MyComputer extends RpcTarget {
  #emit: (event: ComputerEvent) => void;
  #nextCall = 0;

  constructor(emit: (event: ComputerEvent) => void = () => {}) {
    super();
    this.#emit = emit;
  }

  async #call<T>(method: string, summary: string, operation: () => Promise<T>): Promise<T> {
    const id = ++this.#nextCall;
    this.#emit({ type: "call", id, method, summary: summary.slice(0, 160) });
    let ok = false;
    try {
      const result = await operation();
      ok = true;
      return result;
    } finally {
      this.#emit({ type: "call-done", id, ok });
    }
  }

  /** Pop a native dialog on screen and return which button the human clicked. */
  async ask({ question, buttons = ["No", "Yes"] }: { question: string; buttons?: string[] }) {
    return this.#call("ask", question, async () => {
      // AppleScript's `display dialog` supports one to three buttons.
      if (buttons.length < 1 || buttons.length > 3) {
        throw new Error("ask() needs 1–3 buttons (AppleScript dialogs cap at three).");
      }
      const buttonList = buttons.map((b) => `"${escapeForAppleScript(b)}"`).join(", ");
      const { stdout } = await osascript(
        `display dialog "${escapeForAppleScript(question)}" ` +
          // Default to the FIRST button (the caller's safe/decline option, "No" by
          // default): this can run arbitrary local Swift, so an accidental Return
          // must not confirm.
          `buttons {${buttonList}} default button "${escapeForAppleScript(buttons[0]!)}" ` +
          `with title "iterate · myComputer"`,
      );
      // osascript prints e.g. `button returned:Yes` — hand back just the choice.
      return { answer: stdout.trim().replace(/^button returned:/, "") };
    });
  }

  /** Show a desktop notification. */
  async notify({ message, title = "iterate" }: { message: string; title?: string }) {
    return this.#call("notify", message, async () => {
      await osascript(
        `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"`,
      );
      return { ok: true as const };
    });
  }

  /** Run arbitrary Swift and return its output — full power, when an agent needs it. */
  async runSwift({ code }: { code: string }) {
    // `swift -` reads a whole program from stdin and runs it.
    return await this.#call("runSwift", "Swift script", () => run("swift", ["-"], code));
  }

  __describe() {
    return {
      instructions:
        "A live Mac shared by its owner. Ask before destructive actions. Methods: ask({ question, buttons? }), notify({ message, title? }), runSwift({ code }). Swift has full local access.",
      types:
        "ask(input: { question: string; buttons?: string[] }): Promise<{ answer: string }>; notify(input: { message: string; title?: string }): Promise<{ ok: true }>; runSwift(input: { code: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;",
    };
  }
}

async function askComputerName(): Promise<string> {
  const proposed = proposeComputerName();
  // Non-interactive (piped output, an agent): just take the proposal.
  if (!process.stdin.isTTY) return proposed;

  const answer = await prompts.text({
    message: "What should agents call this computer? (camelCase — it becomes the itx.<name> path)",
    placeholder: proposed,
    defaultValue: proposed,
    validate: (value) =>
      /^[a-zA-Z][a-zA-Z0-9]*$/.test((value || "").trim())
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

/** Provision belongs to this connection; signals release it before closing the transport.
 * A disconnect ends sharing visibly. The caller explicitly starts each new share. */
export async function shareMyComputer(input: {
  connection: Awaited<ReturnType<typeof connectIterate>>;
  project: string;
  name?: string;
  json?: boolean;
}) {
  const name = input.name || (await askComputerName());
  using project = await input.connection.session.projects.get(input.project);
  const emit = (event: ComputerEvent) => {
    if (input.json) process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  using _provision = await project.provide(`itx.${name}`, new MyComputer(emit));
  emit({ type: "status", loggedIn: true, name });
  console.error(`itx.${name} is live for project ${input.project}. Press Ctrl-C to stop sharing.`);
  console.error(`Tell your agent to call itx.${name}.__describe() to learn how to use this Mac.`);
  let stop: () => void = () => {};
  const stopped = new Promise<"stopped">((resolve) => {
    stop = () => resolve("stopped");
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (input.json) {
    process.stdin.once("end", stop);
    process.stdin.resume();
    if (process.stdin.readableEnded) stop();
  }
  try {
    const outcome = await Promise.race([stopped, input.connection.closed]);
    if (outcome !== "stopped") {
      throw new Error(
        `Computer sharing disconnected (${outcome.code}: ${outcome.reason || "connection closed"}). Run iterate use-my-computer again to reconnect.`,
      );
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (input.json) {
      process.stdin.removeListener("end", stop);
      process.stdin.pause();
    }
  }
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
