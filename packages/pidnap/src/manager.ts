import { join } from "node:path";
import { cwd as getCwd } from "node:process";
import { mkdirSync } from "node:fs";
import * as v from "valibot";
import { ProcessDefinition } from "./lazy-process.ts";
import type { Logger } from "./logger.ts";
import { TaskList, type NamedProcessDefinition } from "./task-list.ts";
import { CronProcess, CronProcessOptions } from "./cron-process.ts";
import { RestartingProcess, RestartingProcessOptions } from "./restarting-process.ts";
import { EnvManager, type EnvChangeEvent } from "./env-manager.ts";

export const HttpServerConfig = v.object({
  host: v.optional(v.string()),
  port: v.optional(v.number()),
  authToken: v.optional(v.string()),
});
export type HttpServerConfig = v.InferOutput<typeof HttpServerConfig>;

export const CronProcessEntry = v.object({
  name: v.string(),
  definition: ProcessDefinition,
  options: CronProcessOptions,
  envFile: v.optional(v.string()),
});
export type CronProcessEntry = v.InferOutput<typeof CronProcessEntry>;

export const EnvReloadDelay = v.union([v.number(), v.boolean(), v.literal("immediately")]);
export type EnvReloadDelay = v.InferOutput<typeof EnvReloadDelay>;

export const RestartingProcessEntry = v.object({
  name: v.string(),
  definition: ProcessDefinition,
  options: v.optional(RestartingProcessOptions),
  envFile: v.optional(v.string()),
  envReloadDelay: v.optional(EnvReloadDelay),
});
export type RestartingProcessEntry = v.InferOutput<typeof RestartingProcessEntry>;

export const TaskEntry = v.object({
  name: v.string(),
  definition: ProcessDefinition,
  envFile: v.optional(v.string()),
});
export type TaskEntry = v.InferOutput<typeof TaskEntry>;

export const ManagerConfig = v.object({
  http: v.optional(HttpServerConfig),
  cwd: v.optional(v.string()),
  logDir: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  envFile: v.optional(v.string()),
  tasks: v.optional(v.array(TaskEntry)),
  crons: v.optional(v.array(CronProcessEntry)),
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
  | "initializing" // Running task list
  | "running" // All processes running
  | "stopping" // Stopping all processes
  | "stopped"; // Fully stopped

export class Manager {
  private config: ManagerConfig;
  private logger: Logger;
  private envManager: EnvManager;

  private _state: ManagerState = "idle";
  private taskList: TaskList | null = null;
  private cronProcesses: Map<string, CronProcess> = new Map();
  private restartingProcesses: Map<string, RestartingProcess> = new Map();
  private logDir: string;

  // Env reload tracking
  private processEnvReloadConfig: Map<string, EnvReloadDelay> = new Map();
  private envReloadTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private envChangeUnsubscribe: (() => void) | null = null;

  // Shutdown handling
  private signalHandlers: Map<NodeJS.Signals, () => void> = new Map();
  private shutdownPromise: Promise<void> | null = null;
  private isShuttingDown = false;

  constructor(config: ManagerConfig, logger: Logger) {
    const cwd = config.cwd ?? getCwd();
    this.config = config;
    this.logger = logger;
    this.logDir = config.logDir ?? join(cwd, "logs");
    this.ensureLogDirs();

    // Validate that all names are globally unique across tasks, crons, and processes
    this.validateConfigNames();

    const customEnvFiles: Record<string, string> = {};
    for (const task of config.tasks ?? []) {
      if (task.envFile) customEnvFiles[task.name] = task.envFile;
    }
    for (const cron of config.crons ?? []) {
      if (cron.envFile) customEnvFiles[cron.name] = cron.envFile;
    }
    for (const proc of config.processes ?? []) {
      if (proc.envFile) customEnvFiles[proc.name] = proc.envFile;
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
    const allNames: { name: string; type: string }[] = [];

    for (const task of this.config.tasks ?? []) {
      allNames.push({ name: task.name, type: "task" });
    }
    for (const cron of this.config.crons ?? []) {
      allNames.push({ name: cron.name, type: "cron" });
    }
    for (const proc of this.config.processes ?? []) {
      allNames.push({ name: proc.name, type: "process" });
    }

    const seen = new Map<string, string>();
    for (const { name, type } of allNames) {
      const existingType = seen.get(name);
      if (existingType) {
        throw new Error(
          `Duplicate name "${name}" found: already used as ${existingType}, cannot use as ${type}. Names must be globally unique across tasks, crons, and processes.`,
        );
      }
      seen.set(name, type);
    }
  }

  /**
   * Check if a name is already used by any task, cron, or process
   */
  private isNameUsed(name: string): { used: boolean; type?: string } {
    for (const task of this.config.tasks ?? []) {
      if (task.name === name) return { used: true, type: "task" };
    }

    if (this.taskList) {
      for (const task of this.taskList.tasks) {
        for (const proc of task.processes) {
          if (proc.name === name) return { used: true, type: "task" };
        }
      }
    }

    if (this.cronProcesses.has(name)) return { used: true, type: "cron" };
    for (const cron of this.config.crons ?? []) {
      if (cron.name === name) return { used: true, type: "cron" };
    }

    if (this.restartingProcesses.has(name)) return { used: true, type: "process" };
    for (const proc of this.config.processes ?? []) {
      if (proc.name === name) return { used: true, type: "process" };
    }

    return { used: false };
  }

  private applyDefaults(processName: string, definition: ProcessDefinition): ProcessDefinition {
    const envVarsFromManager = this.envManager.getEnvVars(processName);

    return {
      ...definition,
      cwd: definition.cwd ?? this.config.cwd,
      env: {
        ...envVarsFromManager,
        ...this.config.env,
        ...definition.env,
      },
    };
  }

  private processLogFile(name: string): string {
    return join(this.logDir, "process", `${name}.log`);
  }

  private taskLogFile(name: string): string {
    return join(this.logDir, "tasks", `${name}.log`);
  }

  private cronLogFile(name: string): string {
    return join(this.logDir, "cron", `${name}.log`);
  }

  private ensureLogDirs(): void {
    mkdirSync(this.logDir, { recursive: true });
    mkdirSync(join(this.logDir, "process"), { recursive: true });
    mkdirSync(join(this.logDir, "tasks"), { recursive: true });
    mkdirSync(join(this.logDir, "cron"), { recursive: true });
  }

  /**
   * Handle env file changes
   */
  private handleEnvChange(event: EnvChangeEvent): void {
    if (this._state !== "running") return;

    if (event.type === "global") {
      this.logger.info("Global env file changed, reloading all processes as per their policies");
      for (const processName of this.restartingProcesses.keys()) {
        const reloadDelay = this.processEnvReloadConfig.get(processName);
        if (reloadDelay === false) continue;
        this.scheduleProcessReload(processName, reloadDelay);
      }
      return;
    }

    if (event.type === "process") {
      const processName = event.key;
      const reloadDelay = this.processEnvReloadConfig.get(processName);
      if (reloadDelay === false) return;
      this.scheduleProcessReload(processName, reloadDelay);
    }
  }

  /**
   * Schedule a process reload with debouncing
   */
  private scheduleProcessReload(processName: string, reloadDelay?: EnvReloadDelay): void {
    // Clear existing timer if any
    const existingTimer = this.envReloadTimers.get(processName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Determine delay in ms
    let delayMs: number;
    if (reloadDelay === false) {
      return; // Should not happen, but guard anyway
    } else if (reloadDelay === true || reloadDelay === "immediately") {
      delayMs = 0;
    } else if (typeof reloadDelay === "number") {
      delayMs = reloadDelay;
    } else {
      delayMs = 5000; // Default 5 seconds
    }

    this.logger.info(`Scheduling reload for process "${processName}" in ${delayMs}ms`);

    const timer = setTimeout(async () => {
      await this.reloadProcessEnv(processName);
      this.envReloadTimers.delete(processName);
    }, delayMs);

    this.envReloadTimers.set(processName, timer);
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

    // Get the original config for this process
    const processConfig = this.config.processes?.find((p) => p.name === processName);
    if (!processConfig) {
      this.logger.warn(`Process config for "${processName}" not found`);
      return;
    }

    const updatedDefinition = this.applyDefaults(processName, processConfig.definition);
    await proc.reload(updatedDefinition, true);
  }

  get state(): ManagerState {
    return this._state;
  }

  /**
   * Get all cron processes (read-only access)
   */
  getCronProcesses(): ReadonlyMap<string, CronProcess> {
    return this.cronProcesses;
  }

  /**
   * Get a specific cron process by name
   */
  getCronProcess(name: string): CronProcess | undefined {
    return this.cronProcesses.get(name);
  }

  /**
   * Get all restarting processes (read-only access)
   */
  getRestartingProcesses(): ReadonlyMap<string, RestartingProcess> {
    return this.restartingProcesses;
  }

  /**
   * Get a specific restarting process by name
   */
  getRestartingProcess(name: string): RestartingProcess | undefined {
    return this.restartingProcesses.get(name);
  }

  /**
   * Get the task list (read-only access)
   */
  getTaskList(): TaskList | null {
    return this.taskList;
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
   * Get a cron process by name or index
   */
  getCronByTarget(target: string | number): CronProcess | undefined {
    if (typeof target === "string") {
      return this.cronProcesses.get(target);
    }
    const entries = Array.from(this.cronProcesses.values());
    return entries[target];
  }

  /**
   * Get a task by id or index
   */
  getTaskByTarget(
    target: string | number,
  ): { id: string; state: string; processNames: string[] } | undefined {
    if (!this.taskList) return undefined;
    const tasks = this.taskList.tasks;

    if (typeof target === "string") {
      const task = tasks.find((t) => t.id === target);
      if (!task) return undefined;
      return {
        id: task.id,
        state: task.state,
        processNames: task.processes.map((p) => p.name),
      };
    }

    const task = tasks[target];
    if (!task) return undefined;
    return {
      id: task.id,
      state: task.state,
      processNames: task.processes.map((p) => p.name),
    };
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
    },
  ): Promise<RestartingProcess> {
    const proc = this.getProcessByTarget(target);
    if (!proc) {
      throw new Error(`Process not found: ${target}`);
    }

    // Apply global defaults to new definition
    const definitionWithDefaults = this.applyDefaults(proc.name, newDefinition);

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

    // Remove from the map
    this.restartingProcesses.delete(proc.name);
    this.logger.info(`Removed process: ${proc.name}`);
  }

  /**
   * Add a task to the task list
   * Creates the task list if it doesn't exist and starts it
   */
  addTask(
    name: string,
    definition: ProcessDefinition,
    envFile?: string,
  ): { id: string; state: string; processNames: string[] } {
    // Check for global name uniqueness
    const nameCheck = this.isNameUsed(name);
    if (nameCheck.used) {
      throw new Error(
        `Name "${name}" is already used as ${nameCheck.type}. Names must be globally unique across tasks, crons, and processes.`,
      );
    }

    // Register custom env file if provided
    if (envFile) {
      this.envManager.registerFile(name, envFile);
    }

    if (!this.taskList) {
      const taskListLogger = this.logger.child("tasks", {
        logFile: this.taskLogFile("tasks"),
      });
      this.taskList = new TaskList("runtime", taskListLogger, undefined, (processName) => {
        return this.taskLogFile(processName);
      });
    }

    const namedProcess: NamedProcessDefinition = {
      name,
      process: this.applyDefaults(name, definition),
    };
    const id = this.taskList.addTask(namedProcess);

    // Start the task list if it's idle so the task runs immediately
    if (this.taskList.state === "idle") {
      this.taskList.start();
    }

    return {
      id,
      state: "pending",
      processNames: [name],
    };
  }

  removeTaskByTarget(target: string | number): {
    id: string;
    state: string;
    processNames: string[];
  } {
    if (!this.taskList) {
      throw new Error(`Task list not initialized`);
    }

    const removed = this.taskList.removeTaskByTarget(target);
    return {
      id: removed.id,
      state: removed.state,
      processNames: removed.processes.map((p) => p.name),
    };
  }

  /**
   * Add a restarting process at runtime
   */
  async addProcess(
    name: string,
    definition: ProcessDefinition,
    options?: RestartingProcessOptions,
    envReloadDelay?: EnvReloadDelay,
    envFile?: string,
  ): Promise<RestartingProcess> {
    // Check for global name uniqueness
    const nameCheck = this.isNameUsed(name);
    if (nameCheck.used) {
      throw new Error(
        `Name "${name}" is already used as ${nameCheck.type}. Names must be globally unique across tasks, crons, and processes.`,
      );
    }

    // Register custom env file if provided
    if (envFile) {
      this.envManager.registerFile(name, envFile);
    }

    const processLogger = this.logger.child(name, { logFile: this.processLogFile(name) });
    const restartingProcess = new RestartingProcess(
      name,
      this.applyDefaults(name, definition),
      options ?? DEFAULT_RESTART_OPTIONS,
      processLogger,
    );
    this.restartingProcesses.set(name, restartingProcess);

    restartingProcess.start();

    // Track env reload config for this process
    this.processEnvReloadConfig.set(name, envReloadDelay ?? 5000);

    this.logger.info(`Added and started restarting process: ${name}`);
    return restartingProcess;
  }

  /**
   * Trigger a cron process by target
   */
  async triggerCronByTarget(target: string | number): Promise<CronProcess> {
    const cron = this.getCronByTarget(target);
    if (!cron) {
      throw new Error(`Cron not found: ${target}`);
    }
    await cron.trigger();
    return cron;
  }

  /**
   * Start a cron process by target
   */
  startCronByTarget(target: string | number): CronProcess {
    const cron = this.getCronByTarget(target);
    if (!cron) {
      throw new Error(`Cron not found: ${target}`);
    }
    cron.start();
    return cron;
  }

  /**
   * Stop a cron process by target
   */
  async stopCronByTarget(target: string | number, timeout?: number): Promise<CronProcess> {
    const cron = this.getCronByTarget(target);
    if (!cron) {
      throw new Error(`Cron not found: ${target}`);
    }
    await cron.stop(timeout);
    return cron;
  }

  /**
   * Start the manager:
   * 1. Run task list (if configured) and wait for completion
   * 2. Create and start all cron/restarting processes
   */
  async start(): Promise<void> {
    if (this._state !== "idle" && this._state !== "stopped") {
      throw new Error(`Manager is already ${this._state}`);
    }

    this.logger.info(`Starting manager`);

    // Phase 1: Run initialization tasks
    if (this.config.tasks && this.config.tasks.length > 0) {
      this._state = "initializing";
      this.logger.info(`Running initialization tasks`);

      const taskListLogger = this.logger.child("tasks");
      const tasksWithDefaults = this.config.tasks.map((task) => ({
        name: task.name,
        process: this.applyDefaults(task.name, task.definition),
      }));
      this.taskList = new TaskList("init", taskListLogger, tasksWithDefaults, (processName) => {
        return this.taskLogFile(processName);
      });

      this.taskList.start();
      await this.taskList.waitUntilIdle();

      // Check if any tasks failed
      const failedTasks = this.taskList.tasks.filter((t) => t.state === "failed");
      if (failedTasks.length > 0) {
        this._state = "stopped";
        const failedNames = failedTasks.map((t) => t.id).join(", ");
        throw new Error(`Initialization failed: tasks [${failedNames}] failed`);
      }

      this.logger.info(`Initialization tasks completed`);
    }

    // Phase 2: Create and start cron processes
    if (this.config.crons) {
      for (const entry of this.config.crons) {
        const processLogger = this.logger.child(entry.name, {
          logFile: this.cronLogFile(entry.name),
        });
        const cronProcess = new CronProcess(
          entry.name,
          this.applyDefaults(entry.name, entry.definition),
          entry.options,
          processLogger,
        );
        this.cronProcesses.set(entry.name, cronProcess);
        cronProcess.start();
        this.logger.info(`Started cron process: ${entry.name}`);
      }
    }

    // Phase 3: Create and start restarting processes
    if (this.config.processes) {
      for (const entry of this.config.processes) {
        const processLogger = this.logger.child(entry.name, {
          logFile: this.processLogFile(entry.name),
        });
        const restartingProcess = new RestartingProcess(
          entry.name,
          this.applyDefaults(entry.name, entry.definition),
          entry.options ?? DEFAULT_RESTART_OPTIONS,
          processLogger,
        );
        this.restartingProcesses.set(entry.name, restartingProcess);

        restartingProcess.start();

        // Track env reload config for this process
        this.processEnvReloadConfig.set(
          entry.name,
          entry.envReloadDelay ?? 5000, // Default to 5000ms
        );

        this.logger.info(`Started restarting process: ${entry.name}`);
      }
    }

    this._state = "running";
    this.logger.info(
      `Manager started with ${this.cronProcesses.size} cron process(es) and ${this.restartingProcesses.size} restarting process(es)`,
    );
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

    // Stop task list if still running
    if (this.taskList) {
      await this.taskList.stop(timeout);
    }

    // Stop all cron processes in parallel
    const cronStopPromises = Array.from(this.cronProcesses.values()).map((p) => p.stop(timeout));

    // Stop all restarting processes in parallel
    const restartingStopPromises = Array.from(this.restartingProcesses.values()).map((p) =>
      p.stop(timeout),
    );

    await Promise.all([...cronStopPromises, ...restartingStopPromises]);

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
