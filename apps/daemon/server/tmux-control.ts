import { spawnSync } from "node:child_process";

/**
 * Tmux session management using vanilla tmux (default socket).
 *
 * Sessions persist across daemon restarts. The daemon can reconnect to
 * orphaned sessions on startup.
 *
 * Session naming convention: agent:{slug}
 */

const DEFAULT_HISTORY_LIMIT = 50000;

export const ENV_VARS_TO_PROPAGATE = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

export interface TmuxSession {
  name: string;
  windows: number;
  created: Date;
  attached: boolean;
}

export interface PaneInfo {
  pid: number;
  command: string;
}

function runTmuxCommand(args: string[]): { stdout: string; success: boolean } {
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  return {
    stdout: (result.stdout || "").trim(),
    success: result.status === 0,
  };
}

export function isTmuxInstalled(): boolean {
  const result = spawnSync("which", ["tmux"]);
  return result.status === 0;
}

export function isTmuxServerRunning(): boolean {
  const { success } = runTmuxCommand(["list-sessions"]);
  return success;
}

export function setGlobalTmuxEnv(name: string, value: string): boolean {
  const { success } = runTmuxCommand(["set-environment", "-g", name, value]);
  return success;
}

export function unsetGlobalTmuxEnv(name: string): boolean {
  const { success } = runTmuxCommand(["set-environment", "-g", "-u", name]);
  return success;
}

export function propagateApiKeysToTmux(): void {
  for (const key of ENV_VARS_TO_PROPAGATE) {
    const value = process.env[key];
    if (value) {
      setGlobalTmuxEnv(key, value);
    }
  }
}

export function listTmuxSessions(): TmuxSession[] {
  const { stdout, success } = runTmuxCommand([
    "list-sessions",
    "-F",
    "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}",
  ]);

  if (!success || !stdout) {
    return [];
  }

  const sessions: TmuxSession[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name, windowsStr, createdStr, attachedStr] = line.split("|");
    if (!name) continue;
    sessions.push({
      name,
      windows: parseInt(windowsStr, 10) || 1,
      created: new Date(parseInt(createdStr, 10) * 1000),
      attached: attachedStr === "1",
    });
  }
  return sessions;
}

export function getOrphanedSessionNames(): string[] {
  const { stdout, success } = runTmuxCommand(["list-sessions", "-F", "#{session_name}"]);
  if (!success || !stdout) {
    return [];
  }
  return stdout.split("\n").filter(Boolean);
}

export function hasTmuxSession(name: string): boolean {
  const { success } = runTmuxCommand(["has-session", "-t", name]);
  return success;
}

export function createTmuxSession(name: string, command?: string): boolean {
  const args = ["new-session", "-d", "-s", name];
  if (command) {
    args.push(command);
  }
  const { success } = runTmuxCommand(args);
  if (success) {
    runTmuxCommand(["set-option", "-t", name, "history-limit", String(DEFAULT_HISTORY_LIMIT)]);
    runTmuxCommand(["set-option", "-t", name, "status", "off"]);
    runTmuxCommand(["set-option", "-t", name, "mouse", "on"]);
    runTmuxCommand(["set-option", "-t", name, "remain-on-exit", "on"]);
  }
  return success;
}

export function killTmuxSession(name: string): boolean {
  const { success } = runTmuxCommand(["kill-session", "-t", name]);
  return success;
}

export function sendKeys(sessionName: string, keys: string, enter = false): boolean {
  const args = ["send-keys", "-t", sessionName, keys];
  if (enter) {
    args.push("Enter");
  }
  const { success } = runTmuxCommand(args);
  return success;
}

export function sendCtrlC(sessionName: string): boolean {
  const { success } = runTmuxCommand(["send-keys", "-t", sessionName, "C-c"]);
  return success;
}

export function respawnPane(sessionName: string, command: string): boolean {
  const { success } = runTmuxCommand(["respawn-pane", "-k", "-t", sessionName, command]);
  return success;
}

export function capturePane(sessionName: string, lines?: number): string {
  const args = ["capture-pane", "-p", "-t", sessionName];
  if (lines) {
    args.push("-S", `-${lines}`);
  }
  const { stdout } = runTmuxCommand(args);
  return stdout;
}

export function getPaneInfo(sessionName: string): PaneInfo | null {
  const { stdout, success } = runTmuxCommand([
    "list-panes",
    "-t",
    sessionName,
    "-F",
    "#{pane_pid}|#{pane_current_command}",
  ]);
  if (!success || !stdout) {
    return null;
  }
  const [pidStr, command] = stdout.split("|");
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid)) {
    return null;
  }
  return { pid, command: command || "" };
}

export function isSessionProcessRunning(sessionName: string): boolean {
  const info = getPaneInfo(sessionName);
  if (!info) return false;
  const idleCommands = ["bash", "zsh", "sh", "fish"];
  return !idleCommands.includes(info.command);
}

export async function gracefulStop(sessionName: string, timeoutMs = 2000): Promise<boolean> {
  sendCtrlC(sessionName);
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  return killTmuxSession(sessionName);
}

/**
 * Trigger tmux-resurrect save. Call this after session changes.
 */
export function triggerResurrectSave(): boolean {
  const { success } = runTmuxCommand([
    "run-shell",
    "~/.tmux/plugins/tmux-resurrect/scripts/save.sh quiet",
  ]);
  return success;
}

/**
 * Trigger tmux-resurrect restore. Call on daemon startup.
 */
export function triggerResurrectRestore(): boolean {
  const { success } = runTmuxCommand([
    "run-shell",
    "~/.tmux/plugins/tmux-resurrect/scripts/restore.sh",
  ]);
  return success;
}

/**
 * Build a tmux session name from an agent slug.
 * Uses underscore instead of colon since colon is the tmux window/pane separator.
 */
export function buildSessionName(slug: string): string {
  return `agent_${slug}`;
}

/**
 * Parse a slug from a tmux session name.
 * Returns null if the session name doesn't match the agent_ prefix.
 */
export function parseSlugFromSessionName(sessionName: string): string | null {
  if (!sessionName.startsWith("agent_")) {
    return null;
  }
  return sessionName.slice(6); // Remove "agent_" prefix
}
