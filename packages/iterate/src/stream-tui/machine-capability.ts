/**
 * The live capability the chat TUI hands to an agent: the human's actual machine,
 * shared over the TUI's capnweb socket so the agent's calls run locally and stop
 * the moment the chat session drops (the sharing lifetime IS the session lifetime).
 *
 * Conceptually this is an ephemeral, session-scoped sibling of `itx.sandbox` (a
 * live machine with a shell), NOT one of the durable project stores (`itx.files`
 * is a blob store; `itx.workspace` is a git-backed DO checkout). So it mirrors
 * two existing surfaces on purpose:
 *   - `exec` returns `{ stdout, stderr, exitCode }`, like the sandbox.
 *   - the filesystem verbs (`readFile`/`writeFile`/`edit`/`readDir`/`glob`) copy
 *     `itx.workspace`'s signatures — positional args, `readFile → string | null`,
 *     directory/glob → file-info objects — so an agent fluent in the workspace
 *     drives the local machine identically.
 *
 * `instructions`/`types` are what the agent sees through `itx.__describe()`, so
 * they ARE the tool design: keep them accurate.
 */
import { exec as execCallback, execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, resolve } from "node:path";
import { platform } from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(execCallback);
const execFileAsync = promisify(execFileCallback);

/** Cap on captured stdout/stderr so a chatty command can't blow up the payload. */
const MAX_OUTPUT_CHARS = 20_000;
/**
 * `readFile` refuses files larger than this rather than silently truncating —
 * a truncated read fed back into `writeFile`/`edit` would corrupt the file.
 */
const MAX_READ_FILE_BYTES = 1_000_000;
const MAX_GLOB_MATCHES = 1_000;

export type MachineInvocation = {
  method: string;
  /** One-line human summary for the TUI notice, e.g. `exec: ls ~/src`. */
  summary: string;
};

/** Mirrors the shape of `itx.workspace`'s file-info entries (the fields that matter locally). */
type LocalFileInfo = {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
};

type MachineCapability = {
  exec(
    command: string,
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** utf8 file contents, or `null` when the file does not exist (like `itx.workspace.readFile`). */
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  edit(input: {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }): Promise<{ path: string; occurrenceCount: number }>;
  readDir(dir?: string): Promise<LocalFileInfo[]>;
  glob(pattern: string, cwd?: string): Promise<LocalFileInfo[]>;
  notify(message: string): Promise<void>;
};

/** `instructions` shown to the agent through `__describe()`. */
export const MACHINE_CAPABILITY_INSTRUCTIONS =
  "The human's own machine — the one running their `iterate chat` session — shared live over the " +
  "chat socket. Think of it as an ephemeral, session-only sibling of `itx.sandbox`: a real machine " +
  "with a shell, but it is the HUMAN'S computer and it goes away when they close the chat. " +
  "`exec(command, cwd?)` runs a shell command and returns { stdout, stderr, exitCode } (output truncated). " +
  "The filesystem verbs mirror `itx.workspace`: `readFile(path)` returns the utf8 contents or null if " +
  "missing, `writeFile(path, content)`, `edit({ path, oldString, newString, replaceAll? })`, " +
  "`readDir(dir?)` and `glob(pattern, cwd?)` return file-info objects { path, name, type, size }. " +
  "`notify(message)` shows the human a desktop notification. These calls run AS THE HUMAN on their own " +
  "machine, so use absolute or ~-relative paths they'd recognise and ask before anything destructive.";

/** `types` shown to the agent through `__describe()`. */
export const MACHINE_CAPABILITY_TYPES = [
  "{",
  "  exec(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;",
  "  readFile(path: string): Promise<string | null>;",
  "  writeFile(path: string, content: string): Promise<void>;",
  "  edit(input: { path: string; oldString: string; newString: string; replaceAll?: boolean }): Promise<{ path: string; occurrenceCount: number }>;",
  "  readDir(dir?: string): Promise<Array<{ path: string; name: string; type: 'file' | 'directory' | 'symlink'; size: number }>>;",
  "  glob(pattern: string, cwd?: string): Promise<Array<{ path: string; name: string; type: 'file' | 'directory' | 'symlink'; size: number }>>;",
  "  notify(message: string): Promise<void>;",
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

  const fileInfo = async (path: string, name: string): Promise<LocalFileInfo> => {
    const stats = await fs.lstat(path);
    const type = stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "file";
    return { path, name, type, size: stats.size };
  };

  return {
    async exec(command, cwd) {
      announce("exec", command);
      try {
        const { stdout, stderr } = await execAsync(command, { cwd, maxBuffer: 10 * 1024 * 1024 });
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

    async readFile(path) {
      announce("readFile", path);
      let stats: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stats = await fs.stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      if (stats.size > MAX_READ_FILE_BYTES) {
        throw new Error(
          `File is ${stats.size} bytes (> ${MAX_READ_FILE_BYTES} limit). Use exec with head/sed/grep instead of reading it whole.`,
        );
      }
      return await fs.readFile(path, "utf8");
    },

    async writeFile(path, content) {
      announce("writeFile", path);
      await fs.writeFile(path, content, "utf8");
    },

    async edit({ path, oldString, newString, replaceAll }) {
      announce("edit", path);
      const content = await fs.readFile(path, "utf8");
      const occurrenceCount = content.split(oldString).length - 1;
      if (occurrenceCount === 0) {
        throw new Error(`edit: oldString not found in ${path}.`);
      }
      // Match itx.workspace: an ambiguous edit (>1 match, no replaceAll) throws
      // rather than silently changing only the first — the agent must be explicit.
      if (occurrenceCount > 1 && !replaceAll) {
        throw new Error(
          `edit: oldString matched ${occurrenceCount} times in ${path}. Pass replaceAll or make it unique.`,
        );
      }
      const updated = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);
      await fs.writeFile(path, updated, "utf8");
      return { path, occurrenceCount };
    },

    async readDir(dir) {
      const target = dir || process.cwd();
      announce("readDir", target);
      const entries = await fs.readdir(target, { withFileTypes: true });
      return await Promise.all(
        entries.map((entry) => fileInfo(resolve(target, entry.name), entry.name)),
      );
    },

    async glob(pattern, cwd) {
      announce("glob", cwd ? `${pattern} (in ${cwd})` : pattern);
      const base = cwd || process.cwd();
      const matches: LocalFileInfo[] = [];
      for await (const match of fs.glob(pattern, { cwd: base })) {
        const rel = typeof match === "string" ? match : String(match);
        matches.push(await fileInfo(resolve(base, rel), basename(rel)));
        if (matches.length >= MAX_GLOB_MATCHES) break;
      }
      return matches;
    },

    async notify(message) {
      announce("notify", message);
      if (platform() !== "darwin") return;
      // Pass the script as an argv item (no shell) so quotes/apostrophes in the
      // message can't break out of — or inject into — the command. JSON string
      // syntax matches AppleScript's double-quoted, backslash-escaped strings.
      await execFileAsync("osascript", [
        "-e",
        `display notification ${JSON.stringify(message)} with title "iterate"`,
      ]);
    },
  };
}
