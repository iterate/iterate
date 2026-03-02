import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve, basename, isAbsolute, dirname } from "node:path";
import { parse } from "dotenv";
import { watch } from "chokidar";
import { type Logger } from "./logger.ts";

export type EnvChangeEvent =
  | {
      type: "global";
    }
  | {
      type: "process";
      key: string;
    };

export type EnvChangeCallback = (event: EnvChangeEvent) => void;

export interface EnvManagerConfig {
  cwd: string;
  globalEnvFile?: string;
  customEnvFiles?: Record<string, string>;
}

export class EnvManager {
  private globalEnv: Record<string, string> = {};
  private globalEnvPath: string;
  private env: Map<string, Record<string, string>> = new Map();
  private watchers: Map<string, ReturnType<typeof watch>> = new Map();
  private fileToKey: Map<string, string> = new Map();
  private changeCallbacks: Set<EnvChangeCallback> = new Set();
  private cwdWatcher: ReturnType<typeof watch> | null = null;
  private globalEnvDirWatcher: ReturnType<typeof watch> | null = null;
  private globalDeleteTimer: ReturnType<typeof setTimeout> | null = null;
  private customKeys: Set<string> = new Set();
  private logger: Logger;

  constructor(
    private config: EnvManagerConfig,
    logger: Logger,
  ) {
    this.logger = logger;
    this.globalEnvPath = config.globalEnvFile
      ? isAbsolute(config.globalEnvFile)
        ? config.globalEnvFile
        : resolve(config.cwd, config.globalEnvFile)
      : resolve(config.cwd, ".env");

    // Load custom env files first (before auto-discovery)
    this.loadCustomEnvFiles();
    this.loadEnvFilesFromCwd();
    this.watchCwdForNewFiles();
    this.watchGlobalEnvDirectory();
  }

  /**
   * Register a custom env file for a key.
   * Once registered, auto-discovered .env.{key} files will be ignored for this key.
   */
  public registerFile(key: string, filePath: string): void {
    const absolutePath = isAbsolute(filePath) ? filePath : resolve(this.config.cwd, filePath);
    this.logger.debug(`Registering custom env file for "${key}": ${absolutePath}`);
    this.clearKeyState(key);
    this.customKeys.add(key);
    this.loadEnvFile(key, absolutePath);
  }

  public unregisterCustomFile(key: string): void {
    if (!this.customKeys.has(key)) return;

    this.logger.debug(`Unregistering custom env file for "${key}"`);
    this.customKeys.delete(key);
    this.clearKeyState(key);

    const autoPath = resolve(this.config.cwd, `.env.${key}`);
    if (existsSync(autoPath)) {
      this.logger.debug(`Falling back to auto-discovered env file for "${key}": ${autoPath}`);
      this.loadEnvFile(key, autoPath);
    }
  }

  /**
   * Check if a key has a custom env file registered
   */
  public hasCustomFile(key: string): boolean {
    return this.customKeys.has(key);
  }

  private clearKeyState(key: string): void {
    this.env.delete(key);
    for (const [absolutePath, mappedKey] of this.fileToKey.entries()) {
      if (mappedKey !== key) continue;
      const watcher = this.watchers.get(absolutePath);
      if (watcher) {
        watcher.close();
        this.watchers.delete(absolutePath);
      }
      this.fileToKey.delete(absolutePath);
    }
  }

  /**
   * Load custom env files from config
   */
  private loadCustomEnvFiles(): void {
    if (!this.config.customEnvFiles) return;

    for (const [key, filePath] of Object.entries(this.config.customEnvFiles)) {
      this.registerFile(key, filePath);
    }
  }

  public getEnvVars(key: string, options?: { inheritGlobalEnv?: boolean }): Record<string, string> {
    const specificEnv = this.env.get(key);
    const inheritGlobal = options?.inheritGlobalEnv ?? true;
    return {
      ...(inheritGlobal ? this.globalEnv : {}),
      ...specificEnv,
    };
  }

  private loadEnvFilesFromCwd(): void {
    this.logger.debug(`Scanning for env files in: ${this.config.cwd}`);
    if (existsSync(this.globalEnvPath)) this.loadGlobalEnv(this.globalEnvPath);

    try {
      const envFiles = globSync(".env.*", { cwd: this.config.cwd });
      this.logger.debug(`Found ${envFiles.length} env file(s): ${envFiles.join(", ") || "(none)"}`);
      for (const filePath of envFiles) {
        const key = this.getEnvKeySuffix(basename(filePath));
        // Skip if key has a custom file registered
        if (key && !this.customKeys.has(key)) {
          this.loadEnvFile(key, resolve(this.config.cwd, filePath));
        } else if (key && this.customKeys.has(key)) {
          this.logger.debug(
            `Skipping auto-discovered "${filePath}" (custom file registered for "${key}")`,
          );
        }
      }
    } catch (err) {
      this.logger.warn("Failed to scan env files:", err);
    }
  }

  private parseEnvFile(absolutePath: string): Record<string, string> | null {
    try {
      const content = readFileSync(absolutePath, "utf-8");
      const parsed = parse(content) ?? {};
      const keys = Object.keys(parsed);
      this.logger.debug(
        `Parsed env file "${absolutePath}": ${keys.length} variable(s) [${keys.join(", ")}]`,
      );
      return parsed;
    } catch (err) {
      this.logger.warn(`Failed to parse env file: ${absolutePath}`, err);
      return null;
    }
  }

  private getEnvKeySuffix(fileName: string): string | null {
    const match = fileName.match(/^\.env\.(.+)$/);
    return match ? match[1] : null;
  }

  private loadGlobalEnv(absolutePath: string) {
    if (!existsSync(absolutePath)) {
      this.logger.debug(`Global env file not found: ${absolutePath}`);
      return;
    }
    this.logger.debug(`Loading global env file: ${absolutePath}`);
    const parsed = this.parseEnvFile(absolutePath);
    if (parsed) {
      this.globalEnv = parsed;
      this.watchFile(absolutePath);
    }
  }

  private loadEnvFile(key: string, absolutePath: string) {
    this.logger.debug(`Loading env file for "${key}": ${absolutePath}`);
    const parsed = this.parseEnvFile(absolutePath);
    if (!parsed) return;

    this.env.set(key, parsed);
    this.fileToKey.set(absolutePath, key);
    this.watchFile(absolutePath);
  }

  private watchFile(absolutePath: string): void {
    if (this.watchers.has(absolutePath)) return;
    try {
      const watcher = watch(absolutePath, { ignoreInitial: true })
        .on("change", () => {
          this.handleFileChange(absolutePath);
        })
        .on("unlink", () => {
          this.handleFileDelete(absolutePath);
        });

      this.watchers.set(absolutePath, watcher);
    } catch (err) {
      this.logger.warn(`Failed to watch env file: ${absolutePath}`, err);
    }
  }

  /**
   * Watch cwd for new .env.* files
   */
  private watchCwdForNewFiles(): void {
    try {
      this.cwdWatcher = watch(this.config.cwd, {
        ignoreInitial: true,
        depth: 0,
      }).on("add", (filePath) => {
        this.handleNewFile(filePath);
      });
    } catch (err) {
      this.logger.warn(`Failed to watch cwd for new env files:`, err);
    }
  }

  private handleFileChange(absolutePath: string): void {
    this.logger.debug(`File changed: ${absolutePath}`);
    if (absolutePath === this.globalEnvPath && this.globalDeleteTimer) {
      clearTimeout(this.globalDeleteTimer);
      this.globalDeleteTimer = null;
    }
    if (absolutePath === this.globalEnvPath) {
      this.logger.debug(`Global env file changed, reloading`);
      this.loadGlobalEnv(absolutePath);
      this.notifyCallbacks({ type: "global" });
      return;
    }

    const key = this.fileToKey.get(absolutePath);
    if (!key) return;

    this.logger.debug(`Env file changed for "${key}", reloading`);
    const parsed = this.parseEnvFile(absolutePath);
    if (!parsed) return;

    this.env.set(key, parsed);
    this.notifyCallbacks({ type: "process", key });
  }

  private handleFileDelete(absolutePath: string): void {
    this.logger.debug(`File deleted: ${absolutePath}`);
    const watcher = this.watchers.get(absolutePath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(absolutePath);
    }

    if (absolutePath === this.globalEnvPath) {
      // Atomic replace commonly emits unlink+add; delay clear to avoid transient empty env reloads.
      if (this.globalDeleteTimer) {
        clearTimeout(this.globalDeleteTimer);
      }
      this.globalDeleteTimer = setTimeout(() => {
        this.globalDeleteTimer = null;
        if (existsSync(this.globalEnvPath)) {
          this.logger.debug(`Global env file recreated, reloading`);
          this.loadGlobalEnv(this.globalEnvPath);
        } else {
          this.logger.debug(`Global env file deleted, clearing global env`);
          this.globalEnv = {};
        }
        this.notifyCallbacks({ type: "global" });
      }, 200);
      return;
    }

    const key = this.fileToKey.get(absolutePath);
    if (key) {
      this.logger.debug(`Env file deleted for "${key}", removing from registry`);
      this.env.delete(key);
      this.fileToKey.delete(absolutePath);
      this.notifyCallbacks({ type: "process", key });
    }
  }

  private handleNewFile(filePath: string): void {
    const absolutePath = isAbsolute(filePath) ? filePath : resolve(this.config.cwd, filePath);
    this.logger.debug(`New file detected: ${absolutePath}`);

    if (absolutePath === this.globalEnvPath) {
      this.logger.debug(`New global env file detected, loading`);
      this.loadGlobalEnv(absolutePath);
      this.notifyCallbacks({ type: "global" });
      return;
    }

    const key = this.getEnvKeySuffix(basename(filePath));
    // Skip if key has a custom file registered or already loaded
    if (key && !this.customKeys.has(key) && !this.env.has(key)) {
      this.logger.debug(`New env file detected for "${key}", loading`);
      this.loadEnvFile(key, absolutePath);
      this.notifyCallbacks({ type: "process", key });
    } else if (key && this.customKeys.has(key)) {
      this.logger.debug(`Ignoring new file "${filePath}" (custom file registered for "${key}")`);
    } else if (key && this.env.has(key)) {
      this.logger.debug(`Ignoring new file "${filePath}" (env for "${key}" already loaded)`);
    }
  }

  private watchGlobalEnvDirectory(): void {
    const globalDir = dirname(this.globalEnvPath);
    if (globalDir === this.config.cwd) return;
    try {
      this.globalEnvDirWatcher = watch(globalDir, {
        ignoreInitial: true,
        depth: 0,
      })
        .on("add", (filePath) => {
          const absolutePath = isAbsolute(filePath) ? filePath : resolve(globalDir, filePath);
          if (absolutePath !== this.globalEnvPath) return;
          if (this.globalDeleteTimer) {
            clearTimeout(this.globalDeleteTimer);
            this.globalDeleteTimer = null;
          }
          this.logger.debug(`Global env file added, reloading`);
          this.loadGlobalEnv(this.globalEnvPath);
          this.notifyCallbacks({ type: "global" });
        })
        .on("change", (filePath) => {
          const absolutePath = isAbsolute(filePath) ? filePath : resolve(globalDir, filePath);
          if (absolutePath !== this.globalEnvPath) return;
          this.handleFileChange(this.globalEnvPath);
        })
        .on("unlink", (filePath) => {
          const absolutePath = isAbsolute(filePath) ? filePath : resolve(globalDir, filePath);
          if (absolutePath !== this.globalEnvPath) return;
          this.handleFileDelete(this.globalEnvPath);
        });
    } catch (err) {
      this.logger.warn(`Failed to watch global env directory "${globalDir}":`, err);
    }
  }

  private notifyCallbacks(event: EnvChangeEvent): void {
    for (const callback of this.changeCallbacks) callback(event);
  }

  onChange(callback: EnvChangeCallback): () => void {
    this.changeCallbacks.add(callback);
    return () => {
      this.changeCallbacks.delete(callback);
    };
  }

  close(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    if (this.cwdWatcher) {
      this.cwdWatcher.close();
      this.cwdWatcher = null;
    }
    if (this.globalEnvDirWatcher) {
      this.globalEnvDirWatcher.close();
      this.globalEnvDirWatcher = null;
    }
    if (this.globalDeleteTimer) {
      clearTimeout(this.globalDeleteTimer);
      this.globalDeleteTimer = null;
    }

    this.changeCallbacks.clear();
  }
}
