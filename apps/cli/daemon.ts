/**
 * Daemon Service
 *
 * Manages a daemonized server process with PID file tracking.
 * Uses Node.js spawn with detached mode wrapped in Effect.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Option, Schema } from "effect";
import { FileSystem, Path } from "@effect/platform";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Storage backend type */
export type StorageBackend = "memory" | "fs";

/** Daemon configuration */
export interface DaemonConfig {
  readonly pidFile: string;
  readonly logFile: string;
  readonly port: number;
  readonly storage: StorageBackend;
}

/** Data directory for all event-stream files */
export const DATA_DIR = ".iterate";

/** Default config - files in .iterate/ */
export const defaultDaemonConfig: DaemonConfig = {
  pidFile: `${DATA_DIR}/daemon.pid`,
  logFile: `${DATA_DIR}/daemon.log`,
  port: 3000,
  storage: "fs",
};

/** Error for daemon operations */
export class DaemonError extends Schema.TaggedError<DaemonError>()("DaemonError", {
  message: Schema.String,
}) {}

/** Daemon service interface */
export interface Daemon {
  /** Start daemon, returns PID. Fails if already running. */
  readonly start: (config?: Partial<DaemonConfig>) => Effect.Effect<number, DaemonError>;

  /** Stop daemon gracefully (SIGTERM → SIGKILL). Fails if not running. */
  readonly stop: () => Effect.Effect<void, DaemonError>;

  /** Restart daemon, returns new PID */
  readonly restart: (config?: Partial<DaemonConfig>) => Effect.Effect<number, DaemonError>;

  /** Check if daemon is running, returns PID if running */
  readonly status: () => Effect.Effect<Option.Option<number>>;

  /** Get the server URL for the running daemon */
  readonly getServerUrl: () => Effect.Effect<Option.Option<string>>;
}

/** Create daemon service implementation */
const makeDaemonImpl = (fs: FileSystem.FileSystem, path: Path.Path): Daemon => {
  const cwd = process.cwd();

  const resolvePath = (file: string) => path.join(cwd, file);

  /** Read PID from file, returns None if not exists or invalid */
  const readPid = (pidFile: string) =>
    Effect.gen(function* () {
      const pidPath = resolvePath(pidFile);
      const exists = yield* fs.exists(pidPath);
      if (!exists) return Option.none<number>();

      const content = yield* fs.readFileString(pidPath);
      const pid = parseInt(content.trim(), 10);
      if (isNaN(pid)) return Option.none<number>();
      return Option.some(pid);
    }).pipe(Effect.orElseSucceed(() => Option.none<number>()));

  /** Check if a process is running */
  const isRunning = (pid: number) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

  /** Send signal to process */
  const kill = (pid: number, signal: NodeJS.Signals) =>
    Effect.try({
      try: () => process.kill(pid, signal),
      catch: () => new DaemonError({ message: `Failed to send ${signal} to PID ${pid}` }),
    });

  /** Spawn daemonized server process */
  const spawnDaemon = (config: DaemonConfig) =>
    Effect.gen(function* () {
      // Ensure .iterate/ directory exists
      const dataDirPath = resolvePath(DATA_DIR);
      yield* fs.makeDirectory(dataDirPath, { recursive: true }).pipe(Effect.ignore);

      const logPath = resolvePath(config.logFile);
      const out = openSync(logPath, "a");

      // Launch the daemon server from the daemon package
      // The daemon server is in apps/daemon/server.ts
      const daemonPackagePath = join(__dirname, "..", "daemon");
      const serverScript = join(daemonPackagePath, "server.ts");

      const child = spawn("npx", ["tsx", serverScript], {
        detached: true,
        stdio: ["ignore", out, out],
        cwd,
        env: {
          ...process.env,
          PORT: String(config.port),
          DAEMON_STORAGE: config.storage,
        },
      });
      child.unref();
      return child.pid!;
    }).pipe(Effect.orDie);

  /** Stop process gracefully */
  const stopProcess = (pidFile: string): Effect.Effect<void, DaemonError> =>
    Effect.gen(function* () {
      const maybePid = yield* readPid(pidFile);
      if (Option.isNone(maybePid)) {
        return yield* Effect.fail(new DaemonError({ message: "No daemon running" }));
      }

      const pid = maybePid.value;

      // Try graceful shutdown first
      yield* kill(pid, "SIGTERM");
      yield* Effect.sleep("2 seconds");

      // Force kill if still running
      const stillRunning = yield* isRunning(pid);
      if (stillRunning) {
        yield* kill(pid, "SIGKILL");
      }

      // Clean up PID file
      yield* fs.remove(resolvePath(pidFile)).pipe(Effect.ignore);
    });

  const start = (config?: Partial<DaemonConfig>): Effect.Effect<number, DaemonError> =>
    Effect.gen(function* () {
      const cfg = { ...defaultDaemonConfig, ...config };
      const pidPath = resolvePath(cfg.pidFile);

      // Check if already running
      const existing = yield* readPid(cfg.pidFile);
      if (Option.isSome(existing)) {
        const running = yield* isRunning(existing.value);
        if (running) {
          return yield* Effect.fail(
            new DaemonError({ message: `Daemon already running (PID ${existing.value})` }),
          );
        }
      }

      // Spawn daemon
      const pid = yield* spawnDaemon(cfg);
      yield* fs.writeFileString(pidPath, String(pid)).pipe(Effect.ignore);

      // Write port to a separate file for client discovery
      const portPath = resolvePath(`${DATA_DIR}/daemon.port`);
      yield* fs.writeFileString(portPath, String(cfg.port)).pipe(Effect.ignore);

      return pid;
    });

  const stop = (): Effect.Effect<void, DaemonError> => stopProcess(defaultDaemonConfig.pidFile);

  const restart = (config?: Partial<DaemonConfig>): Effect.Effect<number, DaemonError> =>
    Effect.gen(function* () {
      yield* stopProcess(defaultDaemonConfig.pidFile).pipe(Effect.ignore);
      return yield* start(config);
    });

  const status = (): Effect.Effect<Option.Option<number>> =>
    Effect.gen(function* () {
      const maybePid = yield* readPid(defaultDaemonConfig.pidFile);
      if (Option.isNone(maybePid)) return Option.none<number>();

      const running = yield* isRunning(maybePid.value);
      return running ? maybePid : Option.none<number>();
    });

  const getServerUrl = (): Effect.Effect<Option.Option<string>> =>
    Effect.gen(function* () {
      const maybePid = yield* status();
      if (Option.isNone(maybePid)) return Option.none<string>();

      // Read port from file
      const portPath = resolvePath(`${DATA_DIR}/daemon.port`);
      const exists = yield* fs.exists(portPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return Option.some(`http://localhost:${defaultDaemonConfig.port}`);

      const portStr = yield* fs
        .readFileString(portPath)
        .pipe(Effect.orElseSucceed(() => String(defaultDaemonConfig.port)));
      const port = parseInt(portStr.trim(), 10);
      return Option.some(`http://localhost:${isNaN(port) ? defaultDaemonConfig.port : port}`);
    });

  return {
    start,
    stop,
    restart,
    status,
    getServerUrl,
  };
};

/** Daemon service tag and implementation */
export class DaemonService extends Effect.Service<DaemonService>()("@iterate/cli/Daemon", {
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return makeDaemonImpl(fs, path);
  }),
  dependencies: [],
}) {
  static readonly Live: Layer.Layer<DaemonService, never, FileSystem.FileSystem | Path.Path> =
    Layer.effect(
      DaemonService,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return makeDaemonImpl(fs, path) as unknown as DaemonService;
      }),
    );
}
