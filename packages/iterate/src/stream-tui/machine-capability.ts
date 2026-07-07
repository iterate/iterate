/**
 * The live capability the chat TUI hands to an agent when you type `!share`.
 *
 * It exposes a small, JSON-safe surface for poking the machine running the CLI
 * (exec/readFile/writeFile/glob/notify). It's provided as a `type: "live"`
 * capability over the TUI's existing capnweb connection (see agent-connection.ts),
 * so the agent's calls travel back over this socket and stop working the moment
 * the chat session drops — the sharing lifetime is the session lifetime.
 *
 * `instructions`/`types` are what the agent sees through `itx.__describe()`, so
 * they ARE the tool design: keep them accurate.
 */
import { exec as execCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import { platform } from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(execCallback);

/** Cap on captured stdout/stderr so a chatty command can't blow up the payload. */
const MAX_OUTPUT_CHARS = 20_000;
/** Cap on returned file contents / match lists for the same reason. */
const MAX_FILE_CHARS = 200_000;
const MAX_GLOB_MATCHES = 1_000;

export type MachineInvocation = {
  method: string;
  /** One-line human summary for the TUI notice, e.g. `exec: ls ~/src`. */
  summary: string;
};

export type MachineCapability = {
  exec(input: { command: string; cwd?: string }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  readFile(input: { path: string }): Promise<{ content: string }>;
  writeFile(input: { path: string; content: string }): Promise<{ bytesWritten: number }>;
  glob(input: { pattern: string; cwd?: string }): Promise<{ matches: string[] }>;
  notify(input: { message: string }): Promise<void>;
};

/** `instructions` shown to the agent through `__describe()`. */
export const MACHINE_CAPABILITY_INSTRUCTIONS =
  "The machine running the human's `iterate chat` session, shared for this chat only. " +
  "`exec` runs a shell command (sh -c) and returns {stdout, stderr, exitCode}; output is truncated. " +
  "`readFile`/`writeFile` take {path} (utf8). `glob` takes {pattern, cwd?} and returns {matches}. " +
  "`notify` shows the human a desktop notification. Prefer relative-to-home paths the human would " +
  "recognise, and ask before anything destructive — these calls run as the human on their own machine.";

/** `types` shown to the agent through `__describe()`. */
export const MACHINE_CAPABILITY_TYPES = [
  "{",
  "  exec(input: { command: string; cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;",
  "  readFile(input: { path: string }): Promise<{ content: string }>;",
  "  writeFile(input: { path: string; content: string }): Promise<{ bytesWritten: number }>;",
  "  glob(input: { pattern: string; cwd?: string }): Promise<{ matches: string[] }>;",
  "  notify(input: { message: string }): Promise<void>;",
  "}",
].join("\n");

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n…[${omitted} more chars truncated]`;
}

/**
 * Build the live capability. `onInvocation` fires before each method runs so the
 * TUI can show the human what the agent is doing on their machine in real time.
 */
export function createMachineCapability(hooks: {
  onInvocation: (invocation: MachineInvocation) => void;
}): MachineCapability {
  const announce = (method: string, summary: string) =>
    hooks.onInvocation({ method, summary: `${method}: ${summary}` });

  return {
    async exec({ command, cwd }) {
      announce("exec", command);
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
        });
        return {
          stdout: truncate(stdout, MAX_OUTPUT_CHARS),
          stderr: truncate(stderr, MAX_OUTPUT_CHARS),
          exitCode: 0,
        };
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
        return {
          stdout: truncate(err.stdout || "", MAX_OUTPUT_CHARS),
          stderr: truncate(err.stderr || err.message || String(error), MAX_OUTPUT_CHARS),
          exitCode: typeof err.code === "number" ? err.code : 1,
        };
      }
    },

    async readFile({ path }) {
      announce("readFile", path);
      const content = await fs.readFile(path, "utf8");
      return { content: truncate(content, MAX_FILE_CHARS) };
    },

    async writeFile({ path, content }) {
      announce("writeFile", path);
      await fs.writeFile(path, content, "utf8");
      return { bytesWritten: Buffer.byteLength(content, "utf8") };
    },

    async glob({ pattern, cwd }) {
      announce("glob", cwd ? `${pattern} (in ${cwd})` : pattern);
      const matches: string[] = [];
      for await (const match of fs.glob(pattern, cwd ? { cwd } : {})) {
        matches.push(typeof match === "string" ? match : String(match));
        if (matches.length >= MAX_GLOB_MATCHES) break;
      }
      return { matches };
    },

    async notify({ message }) {
      announce("notify", message);
      if (platform() !== "darwin") return;
      const escaped = message.replace(/"/g, '\\"');
      await execAsync(`osascript -e 'display notification "${escaped}" with title "iterate"'`);
    },
  };
}
