import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { cwd as getCwd } from "node:process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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

export const ProcessPersistence = v.picklist(["durable", "ephemeral"]);
export type ProcessPersistence = v.InferOutput<typeof ProcessPersistence>;

export const DesiredProcessState = v.picklist(["running", "stopped"]);
export type DesiredProcessState = v.InferOutput<typeof DesiredProcessState>;

export const RestartingProcessEntry = v.object({
  name: v.string(),
  tags: v.optional(v.array(v.string())),
  definition: ProcessDefinition,
  options: v.optional(RestartingProcessOptions),
  envOptions: v.optional(EnvOptions),
  dependsOn: v.optional(v.array(ProcessDependency)),
  /** Schedule for cron-like execution. When triggered: starts if stopped, restarts if running. */
  schedule: v.optional(ScheduleConfig),
  /** Whether this process should be written to autosave state. */
  persistence: v.optional(ProcessPersistence),
  /** Desired runtime state restored across restarts. */
  desiredState: v.optional(DesiredProcessState),
});
export type RestartingProcessEntry = v.InferOutput<typeof RestartingProcessEntry>;

export const ManagerStateStorageConfig = v.object({
  autosaveFile: v.optional(v.string()),
});
export type ManagerStateStorageConfig = v.InferOutput<typeof ManagerStateStorageConfig>;

export const ManagerConfig = v.object({
  http: v.optional(HttpServerConfig),
  cwd: v.optional(v.string()),
  logDir: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  envFile: v.optional(v.string()),
  processes: v.optional(v.array(RestartingProcessEntry)),
  state: v.optional(ManagerStateStorageConfig),
});
export type ManagerConfig = v.InferOutput<typeof ManagerConfig>;

const AutosaveProcessEntry = v.object({
  name: v.string(),
  definition: ProcessDefinition,
  options: v.optional(RestartingProcessOptions),
  envOptions: v.optional(EnvOptions),
  tags: v.optional(v.array(v.string())),
  persistence: ProcessPersistence,
  desiredState: DesiredProcessState,
});
type AutosaveProcessEntry = v.InferOutput<typeof AutosaveProcessEntry>;

const AutosaveState = v.object({
  version: v.literal(1),
  revision: v.optional(v.number()),
  deleted: v.optional(v.array(v.string())),
  processes: v.optional(v.record(v.string(), AutosaveProcessEntry)),
});
type AutosaveState = v.InferOutput<typeof AutosaveState>;

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
  private autosavePath: string;
  private autosaveEnabled: boolean;
  private autosaveRevision = 0;

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
    this.autosaveEnabled = config.state !== undefined;
    this.autosavePath = this.resolveAutosavePath(cwd, config.state?.autosaveFile);
    this.ensureLogDirs();

    this.validateConfigNames(config.processes ?? []);

    const mergedProcesses = this.buildMergedProcessList(config.processes ?? []);
    this.config = {
      ...config,
      cwd,
      processes: mergedProcesses,
    };

    const customEnvFiles: Record<string, string> = {};
    for (const proc of this.config.processes ?? []) {
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

  private resolveAutosavePath(cwd: string, configuredPath?: string): string {
    const defaultPath = join(homedir(), ".iterate", "pidnap-autosave.json");
    if (!configuredPath) return defaultPath;
    return isAbsolute(configuredPath) ? configuredPath : resolvePath(cwd, configuredPath);
  }

  private validateConfigNames(processes: RestartingProcessEntry[]): void {
    const seen = new Set<string>();
    for (const proc of processes) {
      if (seen.has(proc.name)) {
        throw new Error(`Duplicate process name "${proc.name}"`);
      }
      seen.add(proc.name);
    }
  }

  private normalizeProcessEntry(entry: RestartingProcessEntry): RestartingProcessEntry & {
    persistence: ProcessPersistence;
    desiredState: DesiredProcessState;
  } {
    return {
      ...entry,
      persistence: entry.persistence ?? "durable",
      desiredState: entry.desiredState ?? "running",
    };
  }

  private readAutosaveState(): AutosaveState | null {
    if (!this.autosaveEnabled) return null;
    if (!existsSync(this.autosavePath)) return null;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.autosavePath, "utf-8"));
    } catch (error) {
      throw new Error(`Failed to parse autosave state at ${this.autosavePath}: ${String(error)}`);
    }

    try {
      return v.parse(AutosaveState, raw);
    } catch (error) {
      throw new Error(`Invalid autosave state at ${this.autosavePath}: ${String(error)}`);
    }
  }

  private buildMergedProcessList(base: RestartingProcessEntry[]): RestartingProcessEntry[] {
    const merged = new Map<string, RestartingProcessEntry>();

    for (const entry of base) {
      const normalized = this.normalizeProcessEntry(entry);
      merged.set(entry.name, normalized);
    }

    const autosave = this.readAutosaveState();
    if (!autosave) {
      return Array.from(merged.values());
    }

    this.autosaveRevision = autosave.revision ?? 0;

    for (const [slug, entry] of Object.entries(autosave.processes ?? {})) {
      if (entry.name !== slug) {
        throw new Error(
          `Invalid autosave state at ${this.autosavePath}: key "${slug}" does not match entry name "${entry.name}"`,
        );
      }
      const baseEntry = merged.get(slug);
      const normalized = this.normalizeProcessEntry({
        name: slug,
        definition: entry.definition,
        options: entry.options ?? baseEntry?.options,
        envOptions: entry.envOptions ?? baseEntry?.envOptions,
        tags: entry.tags ?? baseEntry?.tags,
        dependsOn: baseEntry?.dependsOn,
        schedule: baseEntry?.schedule,
        persistence: entry.persistence ?? baseEntry?.persistence,
        desiredState: entry.desiredState ?? baseEntry?.desiredState,
      });
      merged.set(slug, normalized);
    }

    return Array.from(merged.values());
  }

  private buildAutosavePayload(): AutosaveState {
    const processes: Record<string, AutosaveProcessEntry> = {};

    for (const entry of this.config.processes ?? []) {
      const normalized = this.normalizeProcessEntry(entry);
      if (normalized.persistence !== "durable") continue;

      processes[entry.name] = {
        name: entry.name,
        definition: entry.definition,
        options: entry.options,
        envOptions: entry.envOptions,
        tags: entry.tags,
        persistence: normalized.persistence,
        desiredState: normalized.desiredState,
      };
    }

    return {
      version: 1,
      revision: this.autosaveRevision,
      processes,
    };
  }

  private writeAutosaveState(): void {
    if (!this.autosaveEnabled) return;
    this.autosaveRevision += 1;
    const payload = this.buildAutosavePayload();
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const dir = dirname(this.autosavePath);
    mkdirSync(dir, { recursive: true });

    const tempPath = `${this.autosavePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tempPath, serialized, "utf-8");
      const fileHandle = openSync(tempPath, "r");
      try {
        fsyncSync(fileHandle);
      } finally {
        closeSync(fileHandle);
      }
      renameSync(tempPath, this.autosavePath);

      try {
        const dirHandle = openSync(dir, "r");
        try {
          fsyncSync(dirHandle);
        } finally {
          closeSync(dirHandle);
        }
      } catch {
        // best-effort on platforms/filesystems that don't support fsync on dirs
      }
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  }

  private getProcessEntryByName(name: string): RestartingProcessEntry | undefined {
    return this.config.processes?.find((proc) => proc.name === name);
  }

  private upsertProcessEntry(entry: RestartingProcessEntry): void {
    const current = this.config.processes ?? [];
    const index = current.findIndex((proc) => proc.name === entry.name);
    if (index === -1) {
      this.config.processes = [...current, entry];
      return;
    }
    const next = [...current];
    next[index] = entry;
    this.config.processes = next;
  }

  private removeProcessEntryByName(name: string): void {
    this.config.processes = (this.config.processes ?? []).filter((proc) => proc.name !== name);
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
    const name = (this.config.processes ?? [])[target]?.name;
    if (!name) return undefined;
    return this.restartingProcesses.get(name);
  }

  /**
   * Start a restarting process by target
   */
  async startProcessByTarget(target: string | number, persist = true): Promise<RestartingProcess> {
    const proc = this.getProcessByTarget(target);
    if (!proc) {
      throw new Error(`Process not found: ${target}`);
    }

    const entry = this.getProcessEntryByName(proc.name);
    if (entry) {
      this.upsertProcessEntry({
        ...entry,
        desiredState: "running",
        persistence: entry.persistence ?? "durable",
      });
      if (persist) {
        this.writeAutosaveState();
      }
    }

    proc.start();
    return proc;
  }

  /**
   * Stop a restarting process by target
   */
  async stopProcessByTarget(
    target: string | number,
    timeout?: number,
    persist = true,
  ): Promise<RestartingProcess> {
    const proc = this.getProcessByTarget(target);
    if (!proc) {
      throw new Error(`Process not found: ${target}`);
    }

    const entry = this.getProcessEntryByName(proc.name);
    if (entry) {
      this.upsertProcessEntry({
        ...entry,
        desiredState: "stopped",
        persistence: entry.persistence ?? "durable",
      });
      if (persist) {
        this.writeAutosaveState();
      }
    }

    await proc.stop(timeout);
    return proc;
  }

  /**
   * Restart a restarting process by target
   */
  async restartProcessByTarget(
    target: string | number,
    force = false,
    persist = true,
  ): Promise<RestartingProcess> {
    const proc = this.getProcessByTarget(target);
    if (!proc) {
      throw new Error(`Process not found: ${target}`);
    }

    // Re-apply env defaults so the restarted process picks up any env file
    // changes that arrived since it was last started.
    const processConfig = this.config.processes?.find((p) => p.name === proc.name);
    if (processConfig) {
      const updatedDefinition = this.applyDefaults(
        proc.name,
        processConfig.definition,
        processConfig.envOptions,
      );
      proc.updateDefinition(updatedDefinition);
    }

    const entry = this.getProcessEntryByName(proc.name);
    if (entry) {
      this.upsertProcessEntry({
        ...entry,
        desiredState: "running",
        persistence: entry.persistence ?? "durable",
      });
      if (persist) {
        this.writeAutosaveState();
      }
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
      tags?: string[];
      persist?: boolean;
      persistence?: ProcessPersistence;
      desiredState?: DesiredProcessState;
      skipEntryUpdate?: boolean;
    },
  ): Promise<RestartingProcess> {
    const proc = this.getProcessByTarget(target);
    if (!proc) {
      throw new Error(`Process not found: ${target}`);
    }

    const persist = options?.persist ?? true;
    const currentEntry = this.getProcessEntryByName(proc.name);
    const nextDesiredState = options?.desiredState ?? currentEntry?.desiredState ?? "running";
    const nextPersistence = options?.persistence ?? currentEntry?.persistence ?? "durable";

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

    if (options?.tags !== undefined) {
      proc.updateTags(options.tags);
    }

    if (currentEntry && !options?.skipEntryUpdate) {
      const nextEntry: RestartingProcessEntry = {
        ...currentEntry,
        definition: newDefinition,
        options: options?.updateOptions
          ? { ...(currentEntry.options ?? DEFAULT_RESTART_OPTIONS), ...options.updateOptions }
          : currentEntry.options,
        envOptions: options?.envOptions ?? currentEntry.envOptions,
        tags: options?.tags ?? currentEntry.tags,
        persistence: nextPersistence,
        desiredState: nextDesiredState,
      };
      this.upsertProcessEntry(nextEntry);
    }

    // Reload with new definition
    await proc.reload(definitionWithDefaults, options?.restartImmediately ?? true);
    if (nextDesiredState === "stopped") {
      await proc.stop();
    }
    if (persist) {
      this.writeAutosaveState();
    }
    this.logger.info(`Reloaded process: ${proc.name}`);
    return proc;
  }

  /**
   * Remove a restarting process by target
   */
  async removeProcessByTarget(
    target: string | number,
    timeout?: number,
    persist = true,
  ): Promise<void> {
    const proc = this.getProcessByTarget(target);
    if (!proc) {
      throw new Error(`Process not found: ${target}`);
    }

    await proc.stop(timeout);
    this.cleanupProcessResources(proc.name);
    this.restartingProcesses.delete(proc.name);
    this.removeProcessEntryByName(proc.name);

    if (persist) {
      this.writeAutosaveState();
    }

    this.logger.info(`Removed process: ${proc.name}`);
  }

  /** Clean up all resources associated with a process (except the process itself) */
  private cleanupProcessResources(name: string): void {
    this.stateChangeUnsubscribes.get(name)?.();
    this.stateChangeUnsubscribes.delete(name);
    this.schedulers.get(name)?.stop();
    this.schedulers.delete(name);
    this.envManager.unregisterCustomFile(name);
    this.envReloadConfig.delete(name);
    const timer = this.envReloadTimers.get(name);
    if (timer) clearTimeout(timer);
    this.envReloadTimers.delete(name);
  }

  listManagedProcessEntries(): ReadonlyArray<
    RestartingProcessEntry & { persistence: ProcessPersistence; desiredState: DesiredProcessState }
  > {
    return (this.config.processes ?? []).map((entry) => this.normalizeProcessEntry(entry));
  }

  getManagedProcessEntry(target: string | number):
    | (RestartingProcessEntry & {
        persistence: ProcessPersistence;
        desiredState: DesiredProcessState;
      })
    | undefined {
    const name = typeof target === "string" ? target : (this.config.processes ?? [])[target]?.name;
    if (!name) return undefined;
    const entry = this.getProcessEntryByName(name);
    if (!entry) return undefined;
    return this.normalizeProcessEntry(entry);
  }

  async updateProcessConfig(input: {
    processSlug: string;
    definition: ProcessDefinition;
    options?: RestartingProcessOptions;
    envOptions?: EnvOptions;
    tags?: string[];
    persistence?: ProcessPersistence;
    desiredState?: DesiredProcessState;
    restartImmediately?: boolean;
  }): Promise<void> {
    const processSlug = input.processSlug;
    const currentEntry = this.getProcessEntryByName(processSlug);
    const nextPersistence = input.persistence ?? currentEntry?.persistence ?? "durable";
    const nextDesiredState = input.desiredState ?? currentEntry?.desiredState ?? "running";

    const nextEntry: RestartingProcessEntry = {
      name: processSlug,
      definition: input.definition,
      options: input.options ?? currentEntry?.options,
      envOptions: input.envOptions ?? currentEntry?.envOptions,
      tags: input.tags ?? currentEntry?.tags,
      dependsOn: currentEntry?.dependsOn,
      schedule: currentEntry?.schedule,
      persistence: nextPersistence,
      desiredState: nextDesiredState,
    };
    this.upsertProcessEntry(nextEntry);

    const defaultDelay = nextEntry.envOptions?.inheritGlobalEnv === false ? false : 5000;
    this.envReloadConfig.set(processSlug, nextEntry.envOptions?.reloadDelay ?? defaultDelay);
    if (nextEntry.envOptions?.envFile) {
      this.envManager.registerFile(processSlug, nextEntry.envOptions.envFile);
    }

    if (this._state === "running") {
      const runningProc = this.restartingProcesses.get(processSlug);
      if (!runningProc) {
        const processLogger = this.logger.child(processSlug, {
          logFile: this.processLogFile(processSlug),
        });
        const restartingProcess = new RestartingProcess(
          processSlug,
          this.applyDefaults(processSlug, nextEntry.definition, nextEntry.envOptions),
          nextEntry.options ?? DEFAULT_RESTART_OPTIONS,
          processLogger,
          nextEntry.tags,
        );
        this.restartingProcesses.set(processSlug, restartingProcess);
        const unsubscribe = restartingProcess.onStateChange((newState) => {
          this.onProcessStateChange(processSlug, newState);
        });
        this.stateChangeUnsubscribes.set(processSlug, unsubscribe);

        try {
          const entries = this.config.processes ?? [];
          this.dependencyResolver.buildGraph(entries, this.restartingProcesses);
          this.dependencyResolver.validateDependenciesExist();
          this.dependencyResolver.validateNoCycles();
        } catch (error) {
          this.cleanupProcessResources(processSlug);
          this.restartingProcesses.delete(processSlug);
          this.removeProcessEntryByName(processSlug);
          throw error;
        }

        if (
          nextDesiredState === "running" &&
          this.dependencyResolver.areDependenciesMet(processSlug)
        ) {
          restartingProcess.start();
        } else if (nextDesiredState === "running") {
          this.logger.info(`Process ${processSlug} waiting for dependencies before start`);
        }
      } else {
        await this.reloadProcessByTarget(processSlug, nextEntry.definition, {
          restartImmediately: input.restartImmediately ?? nextDesiredState !== "stopped",
          updateOptions: nextEntry.options,
          envOptions: nextEntry.envOptions,
          tags: nextEntry.tags,
          persist: false,
          persistence: nextPersistence,
          desiredState: nextDesiredState,
          skipEntryUpdate: true,
        });
      }
    }

    this.writeAutosaveState();
  }

  async deleteProcessBySlug(processSlug: string): Promise<void> {
    const existing = this.getProcessEntryByName(processSlug);
    if (!existing) return;

    const runningProc = this.restartingProcesses.get(processSlug);
    if (runningProc) {
      await this.removeProcessByTarget(processSlug, undefined, false);
    } else {
      this.removeProcessEntryByName(processSlug);
      this.cleanupProcessResources(processSlug);
    }

    this.writeAutosaveState();
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
        entry.tags,
      );
      this.restartingProcesses.set(entry.name, restartingProcess);
      const defaultDelay = entry.envOptions?.inheritGlobalEnv === false ? false : 5000;
      this.envReloadConfig.set(entry.name, entry.envOptions?.reloadDelay ?? defaultDelay);
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

    // Set up schedulers BEFORE starting processes - if this fails, nothing is running yet
    for (const entry of entries) {
      if (entry.schedule) {
        this.setupScheduler(entry);
      }
    }

    // Start processes with no dependencies (unless they have a schedule and runOnStart is false)
    for (const entry of entries) {
      if (this.dependencyResolver.areDependenciesMet(entry.name)) {
        const proc = this.restartingProcesses.get(entry.name)!;
        if ((entry.desiredState ?? "running") === "stopped") {
          this.logger.info(`Process ${entry.name} desiredState=stopped, skipping auto-start`);
          continue;
        }
        if (entry.schedule && !entry.schedule.runOnStart) {
          this.logger.info(`Process ${entry.name} has schedule, waiting for first trigger`);
          continue;
        }
        proc.start();
        this.logger.info(`Started process: ${entry.name}`);
      }
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
      if ((entry.desiredState ?? "running") === "stopped") continue;

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
