import { spawn, execSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface TmuxSession {
  name: string;
  windows: number;
  created: Date;
  attached: boolean;
}

interface PendingCommand {
  command: string;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  responseLines: string[];
  commandId?: string;
}

function isTmuxInstalled(): boolean {
  try {
    execSync("which tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runTmuxCommand(args: string[]): string {
  try {
    return execSync(["tmux", ...args].join(" "), { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * TmuxControlMode - A singleton that manages tmux sessions.
 *
 * This implementation uses direct command execution rather than control mode (-CC)
 * because control mode requires a proper TTY which isn't available in Node.js
 * process spawning without additional PTY libraries.
 */
export class TmuxControlMode extends EventEmitter {
  private process: ChildProcess | null = null;
  private tmuxSessions: Map<string, TmuxSession> = new Map();
  private buffer = "";
  private commandQueue: PendingCommand[] = [];
  private currentCommand: PendingCommand | null = null;
  private isReady = false;
  private readyResolve: (() => void) | null = null;
  private useDirectCommands = false;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  private static instance: TmuxControlMode | null = null;

  static async getInstance(): Promise<TmuxControlMode> {
    const globalKey = "__tmux_control_mode__";
    const globalInstance = (globalThis as unknown as Record<string, TmuxControlMode | undefined>)[
      globalKey
    ];

    if (globalInstance && globalInstance.isConnected()) {
      return globalInstance;
    }

    if (!this.instance || !this.instance.isConnected()) {
      this.instance = new TmuxControlMode();
      await this.instance.connect();
      (globalThis as unknown as Record<string, TmuxControlMode>)[globalKey] = this.instance;
    }

    return this.instance;
  }

  isConnected(): boolean {
    if (this.useDirectCommands) {
      return isTmuxInstalled();
    }
    return this.process !== null && !this.process.killed;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) {
      return;
    }

    if (!isTmuxInstalled()) {
      console.log("[TmuxControl] tmux not installed, using stub mode");
      this.useDirectCommands = true;
      this.isReady = true;
      return;
    }

    console.log("[TmuxControl] Using direct command mode for tmux");
    this.useDirectCommands = true;
    this.isReady = true;

    await this.refreshTmuxSessions();

    this.refreshInterval = setInterval(() => {
      this.refreshTmuxSessions().catch(() => {});
    }, 2000);

    console.log("[TmuxControl] Connected and ready");
  }

  private async waitForReady(): Promise<void> {
    // The first output from tmux control mode indicates it's ready
    // We'll wait for any output or a timeout
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.isReady = true;
        this.readyResolve?.();
        resolve();
      }, 1000);

      // Check periodically
      const interval = setInterval(() => {
        if (this.isReady) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);

      // Also resolve after a short delay if we get any output
      this.once("output", () => {
        clearInterval(interval);
        clearTimeout(timeout);
        this.isReady = true;
        this.readyResolve?.();
        resolve();
      });
    });
  }

  private handleOutput(data: string): void {
    this.buffer += data;
    this.emit("output", data);

    // Parse control mode output line by line
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    // Skip empty lines
    if (!line.trim()) return;

    // Control mode notifications start with %
    if (line.startsWith("%begin")) {
      // Start of command response block
      // Format: %begin <time> <command-number> <flags>
      // We don't need to do much here, just note we're in a response
      return;
    }

    if (line.startsWith("%end")) {
      // End of command response - resolve pending command
      // Format: %end <time> <command-number> <flags>
      if (this.currentCommand) {
        const response = this.currentCommand.responseLines.join("\n");
        this.currentCommand.resolve(response);
        this.currentCommand = null;
        this.processNextCommand();
      }
      return;
    }

    if (line.startsWith("%error")) {
      // Error response
      if (this.currentCommand) {
        const errorMsg = line.replace(/^%error\s*/, "");
        this.currentCommand.reject(new Error(errorMsg || "Unknown tmux error"));
        this.currentCommand = null;
        this.processNextCommand();
      }
      return;
    }

    if (line.startsWith("%session-changed")) {
      // Session changed notification
      this.emit("tmux-session-changed", line);
      this.refreshTmuxSessions().catch(console.error);
      return;
    }

    if (line.startsWith("%sessions-changed")) {
      // Sessions list changed
      this.refreshTmuxSessions().catch(console.error);
      return;
    }

    if (line.startsWith("%window-")) {
      // Window events (window-add, window-close, window-renamed, etc.)
      this.emit("tmux-window-event", line);
      return;
    }

    if (line.startsWith("%output")) {
      // Pane output - could emit for logging
      // Format: %output <pane-id> <output>
      this.emit("tmux-output", line);
      return;
    }

    if (line.startsWith("%")) {
      // Other notification we don't handle yet
      this.emit("tmux-notification", line);
      return;
    }

    // Regular output line - part of command response
    if (this.currentCommand) {
      this.currentCommand.responseLines.push(line);
    }
  }

  async sendCommand(command: string): Promise<string> {
    if (!this.isConnected()) {
      throw new Error("Not connected to tmux");
    }

    if (this.useDirectCommands) {
      return runTmuxCommand(command.split(" "));
    }

    return new Promise((resolve, reject) => {
      this.commandQueue.push({
        command,
        resolve,
        reject,
        responseLines: [],
      });

      if (!this.currentCommand) {
        this.processNextCommand();
      }
    });
  }

  private processNextCommand(): void {
    if (this.commandQueue.length === 0) return;

    this.currentCommand = this.commandQueue.shift()!;
    this.currentCommand.responseLines = [];

    // Send the command to tmux
    this.process?.stdin?.write(this.currentCommand.command + "\n");
  }

  async listTmuxSessions(): Promise<TmuxSession[]> {
    // Return cached sessions - they're kept up to date via notifications
    return Array.from(this.tmuxSessions.values());
  }

  async refreshTmuxSessions(): Promise<void> {
    try {
      let result: string;

      if (this.useDirectCommands) {
        result = runTmuxCommand([
          "list-sessions",
          "-F",
          "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}",
        ]);
      } else {
        result = await this.sendCommand(
          'list-sessions -F "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}"',
        );
      }

      const newSessions = new Map<string, TmuxSession>();

      for (const line of result.split("\n")) {
        if (!line.trim()) continue;

        const [name, windowsStr, createdStr, attachedStr] = line.split("|");
        if (!name) continue;

        newSessions.set(name, {
          name,
          windows: parseInt(windowsStr, 10) || 1,
          created: new Date(parseInt(createdStr, 10) * 1000),
          attached: attachedStr === "1",
        });
      }

      this.tmuxSessions = newSessions;
      this.emit("tmux-sessions-updated", Array.from(newSessions.values()));
    } catch {
      this.tmuxSessions.clear();
    }
  }

  async createTmuxSession(name?: string): Promise<string> {
    const sessionName = name || `agent-${Date.now()}`;

    if (this.useDirectCommands) {
      runTmuxCommand(["new-session", "-d", "-s", sessionName]);
    } else {
      await this.sendCommand(`new-session -d -s "${sessionName}"`);
    }

    await this.refreshTmuxSessions();
    return sessionName;
  }

  async killTmuxSession(name: string): Promise<void> {
    if (this.useDirectCommands) {
      runTmuxCommand(["kill-session", "-t", name]);
    } else {
      await this.sendCommand(`kill-session -t "${name}"`);
    }
    await this.refreshTmuxSessions();
  }

  private handleExit(): void {
    this.process = null;
    this.isReady = false;
    this.tmuxSessions.clear();

    // Reject any pending commands
    if (this.currentCommand) {
      this.currentCommand.reject(new Error("tmux process exited"));
      this.currentCommand = null;
    }

    for (const cmd of this.commandQueue) {
      cmd.reject(new Error("tmux process exited"));
    }
    this.commandQueue = [];

    this.emit("disconnected");
  }

  disconnect(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    if (this.process) {
      this.process.stdin?.write("detach\n");
      this.process.kill();
      this.process = null;
    }
    this.isReady = false;
  }
}
