import * as v from "valibot";
import { LazyProcess, type ProcessDefinition, type ProcessState } from "./lazy-process.ts";
import type { Logger } from "./logger.ts";

export const RestartPolicy = v.picklist([
  "always",
  "on-failure",
  "never",
  "unless-stopped",
  "on-success",
]);
export type RestartPolicy = v.InferOutput<typeof RestartPolicy>;

export const BackoffStrategy = v.union([
  v.object({
    type: v.literal("fixed"),
    delayMs: v.number(),
  }),
  v.object({
    type: v.literal("exponential"),
    initialDelayMs: v.number(),
    maxDelayMs: v.number(),
    multiplier: v.optional(v.number()),
  }),
]);
export type BackoffStrategy = v.InferOutput<typeof BackoffStrategy>;

export const CrashLoopConfig = v.object({
  maxRestarts: v.number(),
  windowMs: v.number(),
  backoffMs: v.number(),
});
export type CrashLoopConfig = v.InferOutput<typeof CrashLoopConfig>;

export const RestartingProcessOptions = v.object({
  restartPolicy: RestartPolicy,
  backoff: v.optional(BackoffStrategy),
  crashLoop: v.optional(CrashLoopConfig),
  minUptimeMs: v.optional(v.number()),
  maxTotalRestarts: v.optional(v.number()),
});
export type RestartingProcessOptions = v.InferOutput<typeof RestartingProcessOptions>;

export const RestartingProcessState = v.picklist([
  "idle",
  "running",
  "restarting",
  "stopping",
  "stopped",
  "crash-loop-backoff",
  "max-restarts-reached",
]);
export type RestartingProcessState = v.InferOutput<typeof RestartingProcessState>;

const DEFAULT_BACKOFF: BackoffStrategy = { type: "fixed", delayMs: 1000 };
const DEFAULT_CRASH_LOOP: CrashLoopConfig = { maxRestarts: 5, windowMs: 60000, backoffMs: 60000 };

export type StateChangeListener = (newState: RestartingProcessState) => void;

export class RestartingProcess {
  readonly name: string;
  readonly lazyProcess: LazyProcess;
  private options: Required<Omit<RestartingProcessOptions, "maxTotalRestarts">> & {
    maxTotalRestarts?: number;
  };
  private logger: Logger;

  // State tracking
  private _state: RestartingProcessState = "idle";
  private _restartCount = 0;
  private restartTimestamps: number[] = []; // For crash loop detection
  private consecutiveFailures = 0; // For exponential backoff
  private lastStartTime: number | null = null;
  private stopRequested = false;
  private pendingDelayTimeout: ReturnType<typeof setTimeout> | null = null;
  private _hasStarted = false;
  private stateChangeListeners: Set<StateChangeListener> = new Set();

  constructor(
    name: string,
    definition: ProcessDefinition,
    options: RestartingProcessOptions,
    logger: Logger,
  ) {
    this.name = name;
    this.logger = logger;
    this.options = {
      restartPolicy: options.restartPolicy,
      backoff: options.backoff ?? DEFAULT_BACKOFF,
      crashLoop: options.crashLoop ?? DEFAULT_CRASH_LOOP,
      minUptimeMs: options.minUptimeMs ?? 0,
      maxTotalRestarts: options.maxTotalRestarts,
    };
    this.lazyProcess = new LazyProcess(name, definition, logger);
  }

  get state(): RestartingProcessState {
    return this._state;
  }

  get restarts(): number {
    return this._restartCount;
  }

  get hasStarted(): boolean {
    return this._hasStarted;
  }

  get isHealthy(): boolean {
    // For now, healthy means running (no health check implemented yet)
    return this._state === "running";
  }

  /**
   * Subscribe to state changes
   * @returns Unsubscribe function
   */
  onStateChange(listener: StateChangeListener): () => void {
    this.stateChangeListeners.add(listener);
    return () => this.stateChangeListeners.delete(listener);
  }

  private setState(newState: RestartingProcessState): void {
    if (this._state === newState) return;
    this._state = newState;
    for (const listener of this.stateChangeListeners) {
      try {
        listener(newState);
      } catch (err) {
        this.logger.error(`State change listener error:`, err);
      }
    }
  }

  start(): void {
    if (this._state === "running" || this._state === "restarting") {
      throw new Error(`Process "${this.name}" is already ${this._state}`);
    }

    if (this._state === "stopping") {
      throw new Error(`Process "${this.name}" is currently stopping`);
    }

    // Fresh start from terminal states - reset counters
    if (
      this._state === "stopped" ||
      this._state === "idle" ||
      this._state === "max-restarts-reached"
    ) {
      this.resetCounters();
    }

    this.stopRequested = false;
    this.startProcess();
  }

  async stop(timeout?: number): Promise<void> {
    this.stopRequested = true;

    // Clear any pending delays
    if (this.pendingDelayTimeout) {
      clearTimeout(this.pendingDelayTimeout);
      this.pendingDelayTimeout = null;
    }

    if (
      this._state === "idle" ||
      this._state === "stopped" ||
      this._state === "max-restarts-reached"
    ) {
      this.setState("stopped");
      return;
    }

    this.setState("stopping");
    await this.lazyProcess.stop(timeout);
    this.setState("stopped");
    this.logger.info(`RestartingProcess stopped`);
  }

  async restart(force = false): Promise<void> {
    // Fresh start from terminal states - reset counters and no delay
    if (
      this._state === "stopped" ||
      this._state === "idle" ||
      this._state === "max-restarts-reached"
    ) {
      this.resetCounters();
      this.stopRequested = false;
      this.startProcess();
      return;
    }

    // Stop the current process first
    await this.stop();

    this.stopRequested = false;

    if (force) {
      // Force restart - no delay
      this.startProcess();
    } else {
      // Follow normal delay strategy
      const delay = this.calculateDelay();
      if (delay > 0) {
        this.setState("restarting");
        this.logger.info(`Restarting in ${delay}ms`);
        await this.delay(delay);
        if (this.stopRequested) return;
      }
      this.startProcess();
    }
  }

  /**
   * Update process definition and optionally restart with new config
   */
  async reload(newDefinition: ProcessDefinition, restartImmediately = true): Promise<void> {
    this.logger.info(`Reloading process with new definition`);
    this.lazyProcess.updateDefinition(newDefinition);

    if (restartImmediately) {
      // Restart with force=true to apply changes immediately
      await this.restart(true);
    }
  }

  /**
   * Update restart options
   */
  updateOptions(newOptions: Partial<RestartingProcessOptions>): void {
    this.logger.info(`Updating restart options`);
    this.options = {
      ...this.options,
      restartPolicy: newOptions.restartPolicy ?? this.options.restartPolicy,
      backoff: newOptions.backoff ?? this.options.backoff,
      crashLoop: newOptions.crashLoop ?? this.options.crashLoop,
      minUptimeMs: newOptions.minUptimeMs ?? this.options.minUptimeMs,
      maxTotalRestarts: newOptions.maxTotalRestarts ?? this.options.maxTotalRestarts,
    };
  }

  private resetCounters(): void {
    this._restartCount = 0;
    this.consecutiveFailures = 0;
    this.restartTimestamps = [];
  }

  private startProcess(): void {
    this.lastStartTime = Date.now();
    this._hasStarted = true;
    this.setState("running");

    this.lazyProcess
      .reset()
      .then(async () => {
        if (this.stopRequested) return;
        await this.lazyProcess.start();
        return this.lazyProcess.waitForExit();
      })
      .then((exitState) => {
        if (!exitState) return;
        if (this.stopRequested && exitState === "error") {
          this.setState("stopped");
          return;
        }
        if (exitState === "stopped" || exitState === "error") {
          this.handleProcessExit(exitState);
        }
      })
      .catch((err) => {
        if (this.stopRequested) return;
        this.setState("stopped");
        this.logger.error(`Failed to start process:`, err);
      });
  }

  private handleProcessExit(exitState: ProcessState): void {
    if (this.stopRequested) {
      this.setState("stopped");
      return;
    }

    const uptime = this.lastStartTime ? Date.now() - this.lastStartTime : 0;
    const wasHealthy = uptime >= this.options.minUptimeMs;
    const exitedWithError = exitState === "error";

    // Reset consecutive failures if the process ran long enough
    if (wasHealthy) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures++;
    }

    // Check if policy allows restart
    if (!this.shouldRestart(exitedWithError)) {
      this.setState("stopped");
      this.logger.info(
        `Process exited, policy "${this.options.restartPolicy}" does not allow restart`,
      );
      return;
    }

    // Check max total restarts
    if (
      this.options.maxTotalRestarts !== undefined &&
      this._restartCount >= this.options.maxTotalRestarts
    ) {
      this.setState("max-restarts-reached");
      this.logger.warn(`Max total restarts (${this.options.maxTotalRestarts}) reached`);
      return;
    }

    // Record restart timestamp for crash loop detection
    const now = Date.now();
    this.restartTimestamps.push(now);

    // Check for crash loop
    if (this.isInCrashLoop()) {
      this.setState("crash-loop-backoff");
      this.logger.warn(
        `Crash loop detected (${this.options.crashLoop.maxRestarts} restarts in ${this.options.crashLoop.windowMs}ms), backing off for ${this.options.crashLoop.backoffMs}ms`,
      );
      this.scheduleCrashLoopRecovery();
      return;
    }

    // Schedule restart with delay
    this._restartCount++;
    this.scheduleRestart();
  }

  private shouldRestart(exitedWithError: boolean): boolean {
    switch (this.options.restartPolicy) {
      case "always":
        return true;
      case "never":
        return false;
      case "on-failure":
        return exitedWithError;
      case "on-success":
        return !exitedWithError;
      case "unless-stopped":
        return !this.stopRequested;
      default:
        return false;
    }
  }

  private isInCrashLoop(): boolean {
    const { maxRestarts, windowMs } = this.options.crashLoop;
    const now = Date.now();
    const cutoff = now - windowMs;

    // Clean up old timestamps
    this.restartTimestamps = this.restartTimestamps.filter((ts) => ts > cutoff);

    return this.restartTimestamps.length >= maxRestarts;
  }

  private calculateDelay(): number {
    const { backoff } = this.options;

    if (backoff.type === "fixed") {
      return backoff.delayMs;
    }

    // Exponential backoff
    const multiplier = backoff.multiplier ?? 2;
    const delay = backoff.initialDelayMs * multiplier ** this.consecutiveFailures;
    return Math.min(delay, backoff.maxDelayMs);
  }

  private scheduleRestart(): void {
    this.setState("restarting");
    const delay = this.calculateDelay();

    this.logger.info(`Restarting in ${delay}ms (restart #${this._restartCount})`);

    this.pendingDelayTimeout = setTimeout(() => {
      this.pendingDelayTimeout = null;
      if (this.stopRequested) {
        this.setState("stopped");
        return;
      }
      this.startProcess();
    }, delay);
  }

  private scheduleCrashLoopRecovery(): void {
    const { backoffMs } = this.options.crashLoop;

    this.pendingDelayTimeout = setTimeout(() => {
      this.pendingDelayTimeout = null;
      if (this.stopRequested) {
        this.setState("stopped");
        return;
      }

      // Reset crash loop timestamps after backoff
      this.restartTimestamps = [];
      this._restartCount++;
      this.logger.info(`Crash loop backoff complete, restarting (restart #${this._restartCount})`);
      this.startProcess();
    }, backoffMs);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.pendingDelayTimeout = setTimeout(() => {
        this.pendingDelayTimeout = null;
        resolve();
      }, ms);
    });
  }
}
