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
      path?: string;
      method?: string;
      url?: string;
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
    if (!store) {
      return {
        level: "info",
        metadata: {
          defaultContext: true,
          userId: undefined,
          path: "",
          method: "",
          url: "",
          requestId: "",
        },
        logs: [],
        errorTracking: () => {},
      };
    }
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
      ? {
          ...existingContext,
          metadata: { ...metadata, defaultContext: undefined },
          logs: [],
          errorTracking,
        }
      : {
          level: "info",
          metadata: { ...metadata, defaultContext: undefined },
          logs: [],
          errorTracking,
        };
    return this._storage.run(newContext, fn);
  }

  enterWith(metadata: TagLogger.Context["metadata"], errorTracking: TagLogger.ErrorTrackingFn) {
    const existingContext = this._storage.getStore();
    const newContext: TagLogger.Context = existingContext
      ? { ...existingContext, metadata: { ...metadata, defaultContext: undefined }, errorTracking }
      : {
          level: "info",
          metadata: { ...metadata, defaultContext: undefined },
          logs: [],
          errorTracking,
        };
    this._storage.enterWith(newContext);
  }

  /** Check if we're currently in a context */
  hasContext(): boolean {
    return this._storage.getStore() !== undefined;
  }

  /** Run function, only creating context if one doesn't exist */
  ensureContext<T>(
    metadata: TagLogger.Context["metadata"],
    errorTracking: TagLogger.ErrorTrackingFn,
    fn: () => T,
  ): T {
    if (this.hasContext()) {
      return fn();
    }
    return this.runInContext(metadata, errorTracking, fn);
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

/**
 * Creates a proxy that wraps all methods with logger context.
 * Call this at the end of your constructor and return it.
 *
 * Example:
 * ```typescript
 * class MyDurableObject {
 *   constructor() {
 *     // ... initialization
 *     return withLoggerContext(this, logger, (methodName, args) => ({
 *       userId: undefined,
 *       path: undefined,
 *       method: methodName,
 *       url: undefined,
 *       requestId: typeid("req").toString(),
 *     }), posthogErrorTracking);
 *   }
 * }
 * ```
 */
export function withLoggerContext<T extends object>(
  target: T,
  loggerInstance: TagLogger,
  getMetadata: (methodName: string, args: unknown[]) => TagLogger.Context["metadata"],
  errorTracking: TagLogger.ErrorTrackingFn,
): T {
  return new Proxy(target, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // If it's not a function, return as-is
      if (typeof value !== "function") {
        return value;
      }

      // Wrap the function with logger context
      return function (this: T, ...args: unknown[]) {
        const metadata = getMetadata(String(prop), args);
        return loggerInstance.ensureContext(metadata, errorTracking, () => {
          return value.apply(this, args);
        });
      };
    },
  });
}

/**
 * Creates a Hono middleware that wraps each request with logger context.
 * This is an alternative to manually calling runInContext in middleware.
 *
 * Example:
 * ```typescript
 * import { createLoggerMiddleware } from "./tag-logger.ts";
 * import { posthogErrorTracking } from "./posthog-error-tracker.ts";
 *
 * app.use("*", createLoggerMiddleware(logger, (c) => ({
 *   userId: c.var.session?.user?.id || undefined,
 *   path: c.req.path,
 *   method: c.req.method,
 *   url: c.req.url,
 *   requestId: typeid("req").toString(),
 * }), posthogErrorTracking));
 * ```
 */
export function createLoggerMiddleware<Context>(
  loggerInstance: TagLogger,
  getMetadata: (context: Context) => TagLogger.Context["metadata"],
  errorTracking: TagLogger.ErrorTrackingFn,
) {
  return async (c: Context, next: () => Promise<void>) => {
    const metadata = getMetadata(c);
    // Always create a new context for each request to ensure isolation
    await loggerInstance.runInContext(metadata, errorTracking, next);
  };
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
