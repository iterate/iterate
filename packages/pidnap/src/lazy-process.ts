import { setTimeout } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import { spawn, type ChildProcess } from "node:child_process";
import * as v from "valibot";
import type { Logger } from "./logger.ts";

export const ProcessDefinition = v.object({
  command: v.string(),
  args: v.optional(v.array(v.string())),
  cwd: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
});
export type ProcessDefinition = v.InferOutput<typeof ProcessDefinition>;

export const ProcessState = v.picklist([
  "idle",
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
]);
export type ProcessState = v.InferOutput<typeof ProcessState>;

/**
 * Kill a process group (the process and all its descendants).
 * Uses negative PID to target the entire process group.
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    // Negative PID kills the entire process group
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = No such process (already dead)
    // EPERM = Permission denied (might happen if some children already exited)
    if (code === "ESRCH" || code === "EPERM") {
      return true;
    }
    return false;
  }
}

export class LazyProcess {
  readonly name: string;
  definition: ProcessDefinition;
  private logger: Logger;
  private childProcess: ChildProcess | null = null;
  private _state: ProcessState = "idle";
  private processExit = Promise.withResolvers<void>();
  public exitCode: number | null = null;

  constructor(name: string, definition: ProcessDefinition, logger: Logger) {
    this.name = name;
    this.definition = definition;
    this.logger = logger.withPrefix("SYS");
  }

  get state(): ProcessState {
    return this._state;
  }

  async start() {
    if (this._state === "running" || this._state === "starting") {
      throw new Error(`Process "${this.name}" is already ${this._state}`);
    }

    if (this._state === "stopping") {
      throw new Error(`Process "${this.name}" is currently stopping`);
    }

    this._state = "starting";
    this.processExit = Promise.withResolvers<void>();
    this.logger.debug(`Starting process: ${this.definition.command}`);

    try {
      const env = this.definition.env ? { ...process.env, ...this.definition.env } : process.env;

      this.childProcess = spawn(this.definition.command, this.definition.args ?? [], {
        cwd: this.definition.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      this._state = "running";

      if (this.childProcess.stdout) {
        const rl = createInterface({ input: this.childProcess.stdout });
        rl.on("line", (line) => this.logger.withPrefix("OUT").info(line));
        this.processExit.promise.then(() => rl.close());
      }

      if (this.childProcess.stderr) {
        const rl = createInterface({ input: this.childProcess.stderr });
        rl.on("line", (line) => this.logger.withPrefix("ERR").info(line));
        this.processExit.promise.then(() => rl.close());
      }

      this.childProcess.on("exit", (code, signal) => {
        this.exitCode = code;

        if (this._state === "running") {
          if (code === 0) {
            this._state = "stopped";
            this.logger.info(`Process exited with code ${code}`);
          } else if (signal) {
            this._state = "stopped";
            this.logger.info(`Process killed with signal ${signal}`);
          } else {
            this._state = "error";
            this.logger.error(`Process exited with code ${code}`);
          }
        }

        this.processExit.resolve();
      });

      this.childProcess.on("error", (err) => {
        if (this._state !== "stopping" && this._state !== "stopped") {
          this._state = "error";
          this.logger.error(`Process error:`, err);
        }
        this.processExit.resolve();
      });
    } catch (err) {
      this._state = "error";
      this.logger.error(`Failed to start process:`, err);
      throw err;
    }
  }

  async stop(timeout?: number): Promise<void> {
    if (this._state === "idle" || this._state === "stopped" || this._state === "error") {
      return;
    }

    if (this._state === "stopping") {
      // Already stopping, wait for completion
      await this.processExit.promise;
      return;
    }

    if (!this.childProcess) {
      this._state = "stopped";
      return;
    }

    this._state = "stopping";
    const pid = this.childProcess.pid;

    if (pid === undefined) {
      this._state = "stopped";
      this.cleanup();
      return;
    }

    this.logger.debug(`Stopping process group (pid: ${pid}) with SIGTERM`);

    const timeoutMs = timeout ?? 5000;
    const resultRace = Promise.race([
      this.processExit.promise.then(() => "exited" as const),
      setTimeout(timeoutMs, "timeout"),
    ]);

    killProcessGroup(pid, "SIGTERM");

    this.logger.debug(`Waiting for process exit (timeout: ${timeoutMs}ms)`);
    const result = await resultRace;
    this.logger.debug(`process exit result: ${result}`);

    if (result === "timeout") {
      this.logger.warn(`Process did not exit within ${timeoutMs}ms, sending SIGKILL (pid: ${pid})`);
      const killed = killProcessGroup(pid, "SIGKILL");
      this.logger.info(`SIGKILL sent to process group: ${killed ? "success" : "failed"}`);

      const killTimeout = setTimeout(1000, "timeout");
      await Promise.race([this.processExit.promise, killTimeout]);

      if (this.childProcess && !this.childProcess.killed) {
        this.logger.error(`Process still alive after SIGKILL (pid: ${pid})`);
      }
    }

    this._state = "stopped";
    this.cleanup();
    this.logger.info(`Process stopped`);
  }

  async reset(): Promise<void> {
    if (this.childProcess?.pid !== undefined) {
      // Kill the entire process group
      killProcessGroup(this.childProcess.pid, "SIGKILL");
      await this.processExit.promise;
      this.cleanup();
    }

    this._state = "idle";
    // Create a fresh promise for the next process lifecycle
    this.processExit = Promise.withResolvers<void>();
    this.logger.info(`Process reset to idle`);
  }

  updateDefinition(definition: ProcessDefinition): void {
    this.definition = definition;
  }

  async waitForExit(): Promise<ProcessState> {
    if (!this.childProcess) return this._state;
    await this.processExit.promise;
    return this._state;
  }

  private cleanup(): void {
    if (this.childProcess) {
      this.childProcess.removeAllListeners();
      this.childProcess = null;
    }

    this.exitCode = null;
  }
}
