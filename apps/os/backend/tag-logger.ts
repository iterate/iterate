import { AsyncLocalStorage } from "async_hooks";

export namespace TagLogger {
  export type Level = keyof typeof TagLogger.levels;
  export type ErrorTrackingFn = (
    error: Error,
    metadata: TagLogger.Context["metadata"],
  ) => void | Promise<void>;
  export type Context = {
    level: TagLogger.Level;
    metadata: Record<string, unknown> & {
      userId: string | undefined;
      path: string;
      method: string;
      url: string;
      requestId: string;
    };
    logs: Array<{ level: TagLogger.Level; timestamp: Date; args: unknown[] }>;
    errorTracking: TagLogger.ErrorTrackingFn;
  };
  export type Implementation = Record<
    TagLogger.Level,
    (call: { args: unknown[]; metadata: Record<string, unknown> }) => void
  >;
}

export class TagLogger {
  static levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;

  _storage = new AsyncLocalStorage<TagLogger.Context>();

  constructor(readonly _implementation: TagLogger.Implementation) {}

  get context(): TagLogger.Context {
    const store = this._storage.getStore();
    // In tests, provide a default context.
    // We do not want to do this in production as it will cause logs to intermingle.
    if (import.meta.env.MODE === "test" && !store)
      return {
        level: "info",
        metadata: {
          userId: undefined,
          path: "",
          method: "",
          url: "",
          requestId: "",
        },
        logs: [],
        errorTracking: () => {},
      };
    if (!store) throw new Error("No context found for logger");
    return store;
  }

  get level() {
    return this.context.level;
  }

  set level(level: TagLogger.Level) {
    if (!this._storage.getStore())
      throw new Error(`You can't set the level globally. Use .run(...) to scope`);
    this.context.level = level;
  }

  get levelNumber() {
    return TagLogger.levels[this.level];
  }

  withMetadata(metadata: Partial<TagLogger.Context["metadata"]>) {
    this._storage.enterWith({
      ...this.context,
      metadata: { ...this.context.metadata, ...metadata },
    });
  }

  removeMetadata(key: string) {
    this._storage.enterWith({
      ...this.context,
      metadata: { ...this.context.metadata, [key]: undefined },
    });
  }

  getMetadata(key?: string) {
    return key ? this.context.metadata[key] : this.context.metadata;
  }

  _log({ level, args, forget }: { level: TagLogger.Level; args: unknown[]; forget?: boolean }) {
    if (!forget) this.context.logs.push({ level, timestamp: new Date(), args });

    if (this.levelNumber > TagLogger.levels[level]) return;
    this._implementation[level]({ args, metadata: this.context.metadata });
  }

  debug(...args: unknown[]) {
    this._log({ level: "debug", args });
  }

  /** @deprecated Use `info` instead */
  log(...args: unknown[]) {
    this._log({ level: "info", args });
  }

  info(...args: unknown[]) {
    this._log({ level: "info", args });
  }

  warn(...args: unknown[]) {
    this._log({ level: "warn", args });
  }

  /** Runs the logger in a new async context, use this to scope logs to a specific async context */
  runInContext<T>(
    metadata: TagLogger.Context["metadata"],
    errorTracking: TagLogger.ErrorTrackingFn,
    fn: () => T,
  ): T {
    const existingContext = this._storage.getStore();
    const newContext: TagLogger.Context = existingContext
      ? { ...existingContext, metadata, logs: [], errorTracking }
      : { level: "info", metadata, logs: [], errorTracking };
    return this._storage.run(newContext, fn);
  }
  error(error: Error): void; // uses passed error
  error(message: string): void; // wraps with Error
  error(message: string, cause: unknown): void; // wraps with error and sets cause
  error(...args: unknown[]): void {
    let errorToLog: Error;
    if (args[0] instanceof Error) {
      // uses passed error
      errorToLog = args[0];
    } else if (args.length === 1 && typeof args[0] === "string") {
      // wrap with Error
      errorToLog = new Error(args[0]);
    } else if (args.length === 2 && typeof args[0] === "string" && args[1]) {
      errorToLog = new Error(args[0], {
        cause: args[1] instanceof Error ? args[1] : new Error(String(args[1])),
      });
    } else {
      errorToLog = new Error(args.join(" "));
    }
    this.context.errorTracking(errorToLog, this.context.metadata);
    this._log({ level: "error", args: [errorToLog] });
  }
}
function serializeError(error: unknown) {
  if (error instanceof Error) {
    const plain = {};

    Object.getOwnPropertyNames(error).forEach((key) => {
      // @ts-expect-error - we don't care about the type of the error
      plain[key] = error[key];
    });

    return plain;
  }
  return error;
}

const replacer = (_: string, value: unknown) => serializeError(value);

/* eslint-disable no-console -- this is the one place where we use console */
export const logger = new TagLogger({
  debug: ({ args, metadata }) => console.debug(JSON.stringify({ args, metadata }, replacer, 2)),
  info: ({ args, metadata }) => console.info(JSON.stringify({ args, metadata }, replacer, 2)),
  warn: ({ args, metadata }) => console.warn(JSON.stringify({ args, metadata }, replacer, 2)),
  error: ({ args, metadata }) => console.error(JSON.stringify({ args, metadata }, replacer, 2)),
});
