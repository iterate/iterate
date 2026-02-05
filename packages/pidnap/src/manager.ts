import { join } from "node:path";
import { cwd as getCwd } from "node:process";
import { mkdirSync } from "node:fs";
import * as v from "valibot";
import { Cron } from "croner";
import { ProcessDefinition } from "./lazy-process.ts";
import type { Logger } from "./logger.ts";
import { RestartingProcess, RestartingProcessOptions } from "./restarting-process.ts";
import { EnvManager, type EnvChangeEvent } from "./env-manager.ts";
import { DependencyResolver } from "./dependency-resolver.ts";

export const HttpServerConfig = v.object({
  host: v.optional(v.string()),
  port: v.optional(v.number()),
  authToken: v.optional(v.string()),
});
export type HttpServerConfig = v.InferOutput<typeof HttpServerConfig>;

export const EnvReloadDelay = v.union([v.number(), v.boolean(), v.literal("immediately")]);
export type EnvReloadDelay = v.InferOutput<typeof EnvReloadDelay>;

export const EnvOptions = v.object({
  /** Custom env file path (replaces auto-discovered .env.<name>) */
  envFile: v.optional(v.string()),
  /** Whether to inherit process.env from the parent process (default: true) */
  inheritProcessEnv: v.optional(v.boolean()),
  /** Whether to inherit the global .env file (default: true) */
  inheritGlobalEnv: v.optional(v.boolean()),
  /**
   * Delay before reloading when env file changes.
   * - number: delay in ms
   * - true or "immediately": reload immediately
   * - false: don't reload on env changes
   * Default: 5000ms
   */
  reloadDelay: v.optional(EnvReloadDelay),
});
export type EnvOptions = v.InferOutput<typeof EnvOptions>;

// Dependency conditions for process ordering
export const DependencyCondition = v.picklist(["completed", "healthy", "started"]);
export type DependencyCondition = v.InferOutput<typeof DependencyCondition>;

export const ProcessDependency = v.union([
  v.string(), // shorthand: just process name (condition defaults based on target's restartPolicy)
  v.object({
    process: v.string(),
    condition: v.optional(DependencyCondition),
  }),
]);
export type ProcessDependency = v.InferOutput<typeof ProcessDependency>;

// Schedule configuration for cron-like process execution
export const ScheduleConfig = v.object({
  /** Cron expression (e.g., "0 * * * *" for hourly) */
  cron: v.string(),
  /** Run immediately on manager start (default: false) */
  runOnStart: v.optional(v.boolean()),
  /** Timezone for the cron expression (default: system timezone) */
  timezone: v.optional(v.string()),
});
export type ScheduleConfig = v.InferOutput<typeof ScheduleConfig>;

export const RestartingProcessEntry = v.object({
  name: v.string(),
  definition: ProcessDefinition,
  options: v.optional(RestartingProcessOptions),
  envOptions: v.optional(EnvOptions),
  dependsOn: v.optional(v.array(ProcessDependency)),
  /** Schedule for cron-like execution. When triggered: starts if stopped, restarts if running. */
  schedule: v.optional(ScheduleConfig),
});
export type RestartingProcessEntry = v.InferOutput<typeof RestartingProcessEntry>;

export const ManagerConfig = v.object({
  http: v.optional(HttpServerConfig),
  cwd: v.optional(v.string()),
  logDir: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  envFile: v.optional(v.string()),
  processes: v.optional(v.array(RestartingProcessEntry)),
});
export type ManagerConfig = v.InferOutput<typeof ManagerConfig>;

const DEFAULT_RESTART_OPTIONS = {
  restartPolicy: "always" as const,
};
const SHUTDOWN_TIMEOUT_MS = 15000;

// Manager state
export type ManagerState =
  | "idle" // Not started
  | "running" // All processes running
  | "stopping" // Stopping all processes
  | "stopped"; // Fully stopped

export class Manager {
  private config: ManagerConfig;
  private logger: Logger;
  private envManager: EnvManager;

  private _state: ManagerState = "idle";
  private restartingProcesses: Map<string, RestartingProcess> = new Map();
  private logDir: string;

  // Dependency resolution
  private dependencyResolver = new DependencyResolver();
  private stateChangeUnsubscribes: Map<string, () => void> = new Map();

  // Env reload tracking
  private envReloadConfig: Map<string, EnvReloadDelay> = new Map();
  private envReloadTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private envChangeUnsubscribe: (() => void) | null = null;

  // Shutdown handling
  private signalHandlers: Map<NodeJS.Signals, () => void> = new Map();
  private shutdownPromise: Promise<void> | null = null;
  private isShuttingDown = false;

  // Scheduled process tracking
  private schedulers: Map<string, Cron> = new Map();

  constructor(config: ManagerConfig, logger: Logger) {
    const cwd = config.cwd ?? getCwd();
    this.config = config;
    this.logger = logger;
    this.logDir = config.logDir ?? join(cwd, "logs");
    this.ensureLogDirs();

    this.validateConfigNames();

    const customEnvFiles: Record<string, string> = {};
    for (const proc of config.processes ?? []) {
      if (proc.envOptions?.envFile) customEnvFiles[proc.name] = proc.envOptions.envFile;
    }

    this.envManager = new EnvManager(
      {
        cwd,
        globalEnvFile: config.envFile,
        customEnvFiles,
      },
      this.logger.child("env-manager"),
    );

    this.envChangeUnsubscribe = this.envManager.onChange((event) => this.handleEnvChange(event));

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => this.handleSignal(signal);
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  private validateConfigNames(): void {
    const seen = new Set<string>();
    for (const proc of this.config.processes ?? []) {
      if (seen.has(proc.name)) {
        throw new Error(`Duplicate process name "${proc.name}"`);
      }
      seen.add(proc.name);
    }
  }

  private isNameUsed(name: string): boolean {
    if (this.restartingProcesses.has(name)) return true;
    for (const proc of this.config.processes ?? []) {
      if (proc.name === name) return true;
    }
    return false;
  }

  private applyDefaults(
    processName: string,
    definition: ProcessDefinition,
    envOptions?: EnvOptions,
  ): ProcessDefinition {
    const inheritGlobalEnv = envOptions?.inheritGlobalEnv ?? true;
    const inheritProcessEnv = envOptions?.inheritProcessEnv ?? true;
    const envVarsFromManager = this.envManager.getEnvVars(processName, { inheritGlobalEnv });

    return {
      ...definition,
      cwd: definition.cwd ?? this.config.cwd,
      env: {
        ...envVarsFromManager,
        ...this.config.env,
        ...definition.env,
      },
      inheritProcessEnv,
    };
  }

  private processLogFile(name: string): string {
    return join(this.logDir, "process", `${name}.log`);
  }

  /** Get the log file path for a process (for external access) */
  getProcessLogPath(name: string): string {
    return this.processLogFile(name);
  }

  private ensureLogDirs(): void {
    mkdirSync(this.logDir, { recursive: true });
    mkdirSync(join(this.logDir, "process"), { recursive: true });
  }

  /**
   * Handle env file changes
   */
  private handleEnvChange(event: EnvChangeEvent): void {
    if (this._state !== "running") return;

    if (event.type === "global") {
      this.logger.info("Global env file changed, reloading all processes as per their policies");
      for (const name of this.restartingProcesses.keys()) {
        const reloadDelay = this.envReloadConfig.get(name);
        if (reloadDelay === false) continue;
        this.scheduleReload(name, reloadDelay);
      }
      return;
    }

    if (event.type === "process") {
      const name = event.key;
      const reloadDelay = this.envReloadConfig.get(name);
      if (reloadDelay === false) return;

      if (this.restartingProcesses.has(name)) {
        this.scheduleReload(name, reloadDelay);
      }
    }
  }

  /**
   * Schedule a process reload with debouncing
   */
  private scheduleReload(name: string, reloadDelay?: EnvReloadDelay): void {
    const existingTimer = this.envReloadTimers.get(name);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    let delayMs: number;
    if (reloadDelay === false) {
      return;
    } else if (reloadDelay === true || reloadDelay === "immediately") {
      delayMs = 0;
    } else if (typeof reloadDelay === "number") {
      delayMs = reloadDelay;
    } else {
      delayMs = 5000;
    }

    this.logger.info(`Scheduling reload for process "${name}" in ${delayMs}ms`);

    const timer = setTimeout(async () => {
      await this.reloadProcessEnv(name);
      this.envReloadTimers.delete(name);
    }, delayMs);

    this.envReloadTimers.set(name, timer);
  }

  /**
   * Reload a process with updated env vars
   */
  private async reloadProcessEnv(processName: string): Promise<void> {
    const proc = this.restartingProcesses.get(processName);
    if (!proc) {
      this.logger.warn(`Process "${processName}" not found for env reload`);
      return;
    }

    this.logger.info(`Reloading process "${processName}" due to env change`);

    const processConfig = this.config.processes?.find((p) => p.name === processName);
    if (!processConfig) {
      this.logger.warn(`Process config for "${processName}" not found`);
      return;
    }

    const updatedDefinition = this.applyDefaults(
      processName,
      processConfig.definition,
      processConfig.envOptions,
    );
    await proc.reload(updatedDefinition, true);
  }

  get state(): ManagerState {
    return this._state;
  }

  /**
   * Get all processes (read-only access)
   */
  getRestartingProcesses(): ReadonlyMap<string, RestartingProcess> {
    return this.restartingProcesses;
  }

  /**
   * Get a specific process by name
   */
  getRestartingProcess(name: string): RestartingProcess | undefined {
    return this.restartingProcesses.get(name);
  }

  /**
   * Get a restarting process by name or index
   */
  getProcessByTarget(target: string | number): RestartingProcess | undefined {
    if (typeof target === "string") {
      return this.restartingProcesses.get(target);
    }
    const entries = Array.from(this.restartingProcesses.values());
    return entries[target];
  }

  /**
   * Start a restarting process by target
   */
  async startProcessByTarget(target: string | number): Promise<RestartingProcess> {
    const proc = this.getProcessByTarget(target);
    if (!proc) {
      throw new Error(`Process not found: ${target}`);
    }

    proc.start();
    return proc;
  }

  /**
   * Stop a restarting process by target
   */
  async stopProcessByTarget(target: string | number, timeout?: number): Promise<RestartingProcess> {
    const proc = this.getProcessByTarget(target);
    if (!proc) {
      throw new Error(`Process not found: ${target}`);
    }
    await proc.stop(timeout);
    return proc;
  }

  /**
   * Restart a restarting process by target
   */
  async restartProcessByTarget(target: string | number, force = false): Promise<RestartingProcess> {
    const proc = this.getProcessByTarget(target);
    if (!proc) {
      throw new Error(`Process not found: ${target}`);
    }
    await proc.restart(force);
    return proc;
  }

  /**
   * Reload a restarting process with new definition
   */
  async reloadProcessByTarget(
    target: string | number,
    newDefinition: ProcessDefinition,
    options?: {
      restartImmediately?: boolean;
      updateOptions?: Partial<RestartingProcessOptions>;
      envOptions?: EnvOptions;
    },
  ): Promise<RestartingProcess> {
    const proc = this.getProcessByTarget(target);
    if (!proc) {
      throw new Error(`Process not found: ${target}`);
    }

    // Apply global defaults to new definition
    const definitionWithDefaults = this.applyDefaults(
      proc.name,
      newDefinition,
      options?.envOptions,
    );

    // Update options if provided
    if (options?.updateOptions) {
      proc.updateOptions(options.updateOptions);
    }

    // Reload with new definition
    await proc.reload(definitionWithDefaults, options?.restartImmediately ?? true);
    this.logger.info(`Reloaded process: ${proc.name}`);
    return proc;
  }

  /**
   * Remove a restarting process by target
   */
  async removeProcessByTarget(target: string | number, timeout?: number): Promise<void> {
    const proc = this.getProcessByTarget(target);
    if (!proc) {
      throw new Error(`Process not found: ${target}`);
    }

    // Stop the process first
    await proc.stop(timeout);

    // Clean up state change listener
    const unsubscribe = this.stateChangeUnsubscribes.get(proc.name);
    if (unsubscribe) {
      unsubscribe();
      this.stateChangeUnsubscribes.delete(proc.name);
    }

    // Stop and remove scheduler if exists
    const scheduler = this.schedulers.get(proc.name);
    if (scheduler) {
      scheduler.stop();
      this.schedulers.delete(proc.name);
    }

    // Clean up env reload config and timers
    this.envReloadConfig.delete(proc.name);
    const timer = this.envReloadTimers.get(proc.name);
    if (timer) {
      clearTimeout(timer);
      this.envReloadTimers.delete(proc.name);
    }

    // Remove from the map
    this.restartingProcesses.delete(proc.name);
    this.logger.info(`Removed process: ${proc.name}`);
  }

  /**
   * Add a restarting process at runtime
   */
  async addProcess(
    name: string,
    definition: ProcessDefinition,
    options?: RestartingProcessOptions,
    envOptions?: EnvOptions,
  ): Promise<RestartingProcess> {
    if (this.isNameUsed(name)) {
      throw new Error(`Name "${name}" is already in use`);
    }

    // Register custom env file if provided
    if (envOptions?.envFile) {
      this.envManager.registerFile(name, envOptions.envFile);
    }

    const processLogger = this.logger.child(name, { logFile: this.processLogFile(name) });
    const restartingProcess = new RestartingProcess(
      name,
      this.applyDefaults(name, definition, envOptions),
      options ?? DEFAULT_RESTART_OPTIONS,
      processLogger,
    );
    this.restartingProcesses.set(name, restartingProcess);

    restartingProcess.start();

    // Track env reload config for this process (default 5000ms)
    this.envReloadConfig.set(name, envOptions?.reloadDelay ?? 5000);

    this.logger.info(`Added and started restarting process: ${name}`);
    return restartingProcess;
  }

  /**
   * Start the manager using dependency-based process ordering
   */
  async start(): Promise<void> {
    if (this._state !== "idle" && this._state !== "stopped") {
      throw new Error(`Manager is already ${this._state}`);
    }

    this.logger.info(`Starting manager`);

    const entries = this.config.processes ?? [];
    if (entries.length === 0) {
      this._state = "running";
      this.logger.info(`Manager started with 0 processes`);
      return;
    }

    // Create all processes upfront
    for (const entry of entries) {
      const processLogger = this.logger.child(entry.name, {
        logFile: this.processLogFile(entry.name),
      });
      const restartingProcess = new RestartingProcess(
        entry.name,
        this.applyDefaults(entry.name, entry.definition, entry.envOptions),
        entry.options ?? DEFAULT_RESTART_OPTIONS,
        processLogger,
      );
      this.restartingProcesses.set(entry.name, restartingProcess);
      this.envReloadConfig.set(entry.name, entry.envOptions?.reloadDelay ?? 5000);
    }

    // Build and validate dependency graph
    this.dependencyResolver.buildGraph(entries, this.restartingProcesses);
    this.dependencyResolver.validateDependenciesExist();
    this.dependencyResolver.validateNoCycles();

    // Subscribe to state changes to start dependents
    for (const proc of this.restartingProcesses.values()) {
      const unsubscribe = proc.onStateChange((newState) => {
        this.onProcessStateChange(proc.name, newState);
      });
      this.stateChangeUnsubscribes.set(proc.name, unsubscribe);
    }

    // Start processes with no dependencies (unless they have a schedule and runOnStart is false)
    for (const entry of entries) {
      if (this.dependencyResolver.areDependenciesMet(entry.name)) {
        const proc = this.restartingProcesses.get(entry.name)!;
        // Skip starting scheduled processes unless runOnStart is true
        if (entry.schedule && !entry.schedule.runOnStart) {
          this.logger.info(`Process ${entry.name} has schedule, waiting for first trigger`);
          continue;
        }
        proc.start();
        this.logger.info(`Started process: ${entry.name}`);
      }
    }

    // Set up schedulers for processes with schedule config
    // Wrap in try-catch to ensure cleanup on failure
    try {
      for (const entry of entries) {
        if (entry.schedule) {
          this.setupScheduler(entry);
        }
      }
    } catch (err) {
      this.logger.error(`Failed to set up schedulers, cleaning up:`, err);
      // Stop all processes that were started
      const stopPromises = Array.from(this.restartingProcesses.values()).map((p) => p.stop());
      await Promise.all(stopPromises);
      // Clean up state change listeners
      for (const unsubscribe of this.stateChangeUnsubscribes.values()) {
        unsubscribe();
      }
      this.stateChangeUnsubscribes.clear();
      // Clean up any schedulers that were set up before the error
      for (const scheduler of this.schedulers.values()) {
        scheduler.stop();
      }
      this.schedulers.clear();
      throw err;
    }

    this._state = "running";
    this.logger.info(`Manager started with ${this.restartingProcesses.size} process(es)`);
  }

  /**
   * Set up a cron scheduler for a process
   */
  private setupScheduler(entry: RestartingProcessEntry): void {
    if (!entry.schedule) return;

    const { cron: cronExpr, timezone } = entry.schedule;
    const proc = this.restartingProcesses.get(entry.name);
    if (!proc) return;

    const scheduler = new Cron(cronExpr, { timezone }, () => {
      this.triggerScheduledProcess(entry.name);
    });

    this.schedulers.set(entry.name, scheduler);
    this.logger.info(`Scheduled process ${entry.name} with cron: ${cronExpr}`);
  }

  /**
   * Trigger a scheduled process: start if stopped/idle, restart if running
   */
  private triggerScheduledProcess(name: string): void {
    const proc = this.restartingProcesses.get(name);
    if (!proc) {
      this.logger.error(`Scheduled process ${name} not found`);
      return;
    }

    const state = proc.state;
    this.logger.info(`Schedule triggered for ${name} (current state: ${state})`);

    if (state === "running" || state === "restarting") {
      // Restart if already running
      proc.restart().catch((err) => {
        this.logger.error(`Failed to restart scheduled process ${name}:`, err);
      });
    } else if (state === "idle" || state === "stopped") {
      // Check dependencies before starting
      if (this.dependencyResolver.areDependenciesMet(name)) {
        proc.start();
      } else {
        this.logger.warn(`Cannot start scheduled process ${name}: dependencies not met`);
      }
    } else {
      this.logger.warn(`Cannot trigger scheduled process ${name} in state: ${state}`);
    }
  }

  /**
   * Handle process state changes to start dependents
   */
  private onProcessStateChange(name: string, newState: string): void {
    if (this._state !== "running") return;

    // Check if any pending processes can now start
    for (const entry of this.config.processes ?? []) {
      const proc = this.restartingProcesses.get(entry.name);
      if (!proc || proc.state !== "idle") continue;

      if (this.dependencyResolver.areDependenciesMet(entry.name)) {
        proc.start();
        this.logger.info(`Started process: ${entry.name} (dependency ${name} is now ${newState})`);
      }
    }

    // Note: Failed dependency handling (marking dependents as dependency-failed)
    // could be added here in the future when dependency-failed state is implemented
  }

  /**
   * Stop all managed processes
   */
  async stop(timeout?: number): Promise<void> {
    if (this._state === "idle" || this._state === "stopped") {
      this._state = "stopped";
      return;
    }

    this._state = "stopping";
    this.logger.info(`Stopping manager`);

    // Clear all env reload timers
    for (const timer of this.envReloadTimers.values()) {
      clearTimeout(timer);
    }
    this.envReloadTimers.clear();

    // Stop all schedulers
    for (const scheduler of this.schedulers.values()) {
      scheduler.stop();
    }
    this.schedulers.clear();

    // Unsubscribe from state changes
    for (const unsubscribe of this.stateChangeUnsubscribes.values()) {
      unsubscribe();
    }
    this.stateChangeUnsubscribes.clear();

    // Unsubscribe from env changes
    if (this.envChangeUnsubscribe) {
      this.envChangeUnsubscribe();
      this.envChangeUnsubscribe = null;
    }

    this.envManager.close();

    for (const [signal, handler] of this.signalHandlers) {
      process.off(signal, handler);
    }
    this.signalHandlers.clear();

    // Stop all processes in parallel
    const stopPromises = Array.from(this.restartingProcesses.values()).map((p) => p.stop(timeout));
    await Promise.all(stopPromises);

    this._state = "stopped";
    this.logger.info(`Manager stopped`);
  }

  /**
   * Wait for shutdown to complete (useful for keeping process alive)
   * Resolves when the manager has fully stopped
   */
  async waitForShutdown(): Promise<void> {
    // If already stopped, return immediately
    if (this._state === "stopped") {
      return;
    }

    // If shutdown is in progress, wait for it
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    // Wait for state to become stopped
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this._state === "stopped") {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Trigger graceful shutdown programmatically
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn(`Shutdown already in progress`);
      if (this.shutdownPromise) {
        await this.shutdownPromise;
      }
      return;
    }

    this.isShuttingDown = true;
    this.logger.info(`Initiating graceful shutdown (timeout: ${SHUTDOWN_TIMEOUT_MS}ms)`);

    this.shutdownPromise = this.performShutdown();
    await this.shutdownPromise;
  }

  private handleSignal(signal: NodeJS.Signals): void {
    this.logger.info(`Received ${signal}, initiating graceful shutdown...`);

    // Prevent handling multiple signals
    if (this.isShuttingDown) {
      this.logger.warn(`Shutdown already in progress, ignoring ${signal}`);
      return;
    }

    this.isShuttingDown = true;
    this.shutdownPromise = this.performShutdown();

    this.shutdownPromise
      .then(() => {
        this.logger.info(`Exiting with code 0`);
        process.exit();
      })
      .catch((err) => {
        this.logger.error(`Shutdown error:`, err);
        process.exit(1);
      });
  }

  private async performShutdown(): Promise<void> {
    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms`));
      }, SHUTDOWN_TIMEOUT_MS);
    });

    try {
      // Race between graceful stop and timeout
      await Promise.race([this.stop(SHUTDOWN_TIMEOUT_MS), timeoutPromise]);
      this.logger.info(`Graceful shutdown completed`);
    } catch (err) {
      this.logger.error(`Shutdown error:`, err);
      // Force stop on timeout
      this._state = "stopped";
      throw err;
    } finally {
      this.isShuttingDown = false;
      this.shutdownPromise = null;
    }
  }
}
