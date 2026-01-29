import { Cron } from "croner";
import * as v from "valibot";
import { LazyProcess, type ProcessDefinition } from "./lazy-process.ts";
import type { Logger } from "./logger.ts";

export const RetryConfig = v.object({
  maxRetries: v.number(),
  delayMs: v.optional(v.number()),
});
export type RetryConfig = v.InferOutput<typeof RetryConfig>;

export const CronProcessOptions = v.object({
  schedule: v.string(),
  retry: v.optional(RetryConfig),
  runOnStart: v.optional(v.boolean()),
});
export type CronProcessOptions = v.InferOutput<typeof CronProcessOptions>;

export const CronProcessState = v.picklist([
  "idle",
  "scheduled",
  "running",
  "retrying",
  "queued",
  "stopping",
  "stopped",
]);
export type CronProcessState = v.InferOutput<typeof CronProcessState>;

const DEFAULT_RETRY_DELAY = 1000;

export class CronProcess {
  readonly name: string;
  readonly lazyProcess: LazyProcess;
  private options: CronProcessOptions;
  private logger: Logger;
  private cronJob: Cron | null = null;

  private _state: CronProcessState = "idle";
  private _runCount = 0;
  private _failCount = 0;
  private currentRetryAttempt = 0;
  private queuedRun = false;
  private stopRequested = false;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    name: string,
    definition: ProcessDefinition,
    options: CronProcessOptions,
    logger: Logger,
  ) {
    this.name = name;
    this.options = options;
    this.logger = logger;
    this.lazyProcess = new LazyProcess(name, definition, logger);
  }

  get state(): CronProcessState {
    return this._state;
  }

  get runCount(): number {
    return this._runCount;
  }

  get failCount(): number {
    return this._failCount;
  }

  get nextRun(): Date | null {
    if (!this.cronJob) return null;
    const next = this.cronJob.nextRun();
    return next ?? null;
  }

  start(): void {
    if (this._state === "scheduled" || this._state === "running" || this._state === "queued") {
      throw new Error(`CronProcess "${this.name}" is already ${this._state}`);
    }

    if (this._state === "stopping") {
      throw new Error(`CronProcess "${this.name}" is currently stopping`);
    }

    this.stopRequested = false;
    this.logger.info(`Starting cron schedule: ${this.options.schedule}`);

    this.cronJob = new Cron(this.options.schedule, { timezone: "UTC" }, () => {
      this.onCronTick();
    });

    this._state = "scheduled";

    if (this.options.runOnStart) {
      this.executeJob();
    }
  }

  async stop(timeout?: number): Promise<void> {
    this.stopRequested = true;

    // Stop the cron job
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }

    // Clear any pending retry timeout
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }

    if (this._state === "idle" || this._state === "stopped") {
      this._state = "stopped";
      return;
    }

    // If running, stop the current job
    if (this._state === "running" || this._state === "retrying" || this._state === "queued") {
      this._state = "stopping";
      await this.lazyProcess.stop(timeout);
    }

    this._state = "stopped";
    this.queuedRun = false;
    this.logger.info(`CronProcess stopped`);
  }

  async trigger(): Promise<void> {
    if (this.stopRequested) {
      throw new Error(`CronProcess "${this.name}" is stopped`);
    }

    // If already queued, just return (already have a run pending)
    if (this._state === "queued") {
      return;
    }

    // If already running, queue this trigger
    if (this._state === "running" || this._state === "retrying") {
      this.queuedRun = true;
      this._state = "queued";
      this.logger.info(`Run queued (current job still running)`);
      return;
    }

    await this.executeJob();
  }

  /**
   * Update the process definition (e.g., for env changes).
   * Takes effect on the next scheduled run.
   */
  updateDefinition(definition: ProcessDefinition): void {
    this.lazyProcess.updateDefinition(definition);
    this.logger.info(`Definition updated, will take effect on next run`);
  }

  private onCronTick(): void {
    if (this.stopRequested) return;

    // If already running, queue the next run
    if (this._state === "running" || this._state === "retrying" || this._state === "queued") {
      this.queuedRun = true;
      if (this._state !== "queued") {
        this._state = "queued";
      }
      this.logger.info(`Cron tick: run queued (current job still running)`);
      return;
    }

    this.executeJob();
  }

  private async executeJob(): Promise<void> {
    if (this.stopRequested) return;

    this._state = "running";
    this.currentRetryAttempt = 0;
    this.logger.info(`Executing job`);

    await this.runJobWithRetry();
  }

  private async runJobWithRetry(): Promise<void> {
    if (this.stopRequested) return;

    // Reset and start the process
    await this.lazyProcess.reset();
    await this.lazyProcess.start();

    const exitState = await this.lazyProcess.waitForExit();
    if (this.stopRequested && exitState === "error") {
      this._state = "stopped";
      return;
    }
    this.handleJobComplete(exitState === "error");
  }

  private handleJobComplete(failed: boolean): void {
    if (this.stopRequested) {
      this._state = "stopped";
      return;
    }

    if (failed) {
      const maxRetries = this.options.retry?.maxRetries ?? 0;

      if (this.currentRetryAttempt < maxRetries) {
        // Retry
        this.currentRetryAttempt++;
        this._state = "retrying";
        const delayMs = this.options.retry?.delayMs ?? DEFAULT_RETRY_DELAY;

        this.logger.warn(
          `Job failed, retrying in ${delayMs}ms (attempt ${this.currentRetryAttempt}/${maxRetries})`,
        );

        this.retryTimeout = setTimeout(() => {
          this.retryTimeout = null;
          if (this.stopRequested) {
            this._state = "stopped";
            return;
          }
          this.runJobWithRetry();
        }, delayMs);
        return;
      }

      // All retries exhausted
      this._failCount++;
      this.logger.error(`Job failed after ${this.currentRetryAttempt} retries`);
    } else {
      this._runCount++;
      this.logger.info(`Job completed successfully`);
    }

    // Check for queued run
    if (this.queuedRun) {
      this.queuedRun = false;
      this.logger.info(`Starting queued run`);
      this.executeJob();
      return;
    }

    // Back to scheduled state
    if (this.cronJob) {
      this._state = "scheduled";
    } else {
      this._state = "stopped";
    }
  }
}
