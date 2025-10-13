import { AsyncLocalStorage } from "async_hooks";
import { waitUntil } from "../env.ts";

// Primitive types for metadata
type Primitive = string | number | boolean | null | undefined;

export namespace TagLogger {
  export type Level = keyof typeof TagLogger.levels;
  export type Context = {
    level: TagLogger.Level;
    metadata: Record<string, Primitive> & {
      userId: string | undefined;
      path?: string;
      httpMethod?: string;
      methodName?: string;
      url?: string;
      traceId: string;
      message?: never;
    };
    logs: Array<{ level: TagLogger.Level; timestamp: Date; message: string }>;
    debugMemories: Array<{ timestamp: Date; message: string }>;
  };
  export type Implementation = Record<
    TagLogger.Level,
    (call: {
      message: string;
      metadata: Record<string, Primitive>;
      debugMemories?: Array<{ timestamp: Date; message: string }>;
      errorObject?: Error;
    }) => void
  >;
}

export class TagLogger {
  static levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;

  _storage = new AsyncLocalStorage<TagLogger.Context>();

  constructor(readonly _implementation: TagLogger.Implementation) {}

  get context(): TagLogger.Context {
    const store = this._storage.getStore();
    if (store) {
      return store;
    }
    // In tests, provide a default context.
    // We do not want to do this in production as it will cause logs to intermingle.
    return {
      level: "info",
      metadata: {
        userId: undefined,
        path: "",
        httpMethod: "",
        url: "",
        traceId: "",
      },
      logs: [],
      debugMemories: [],
    };
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

  addMetadata(metadata: Partial<TagLogger.Context["metadata"]>) {
    // Directly mutate the context metadata instead of using enterWith (not supported in Cloudflare Workers)
    Object.assign(this.context.metadata, metadata);
  }

  removeMetadata(key: string) {
    // Directly mutate the context metadata instead of using enterWith (not supported in Cloudflare Workers)
    this.context.metadata[key] = undefined;
  }

  getMetadata(key?: string) {
    return key ? this.context.metadata[key] : this.context.metadata;
  }

  _log({ level, args }: { level: TagLogger.Level; args: unknown[] }) {
    // Serialize args to a message string
    const message = args
      .map((arg) => {
        if (arg instanceof Error) {
          // For errors, just use the message here - the full error will be in metadata for error level
          return arg.message;
        }
        if (typeof arg === "string") {
          return arg;
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");

    // Store debug logs as memories
    if (level === "debug") {
      this.context.debugMemories.push({ timestamp: new Date(), message });
    }

    // Always store the log (except debug logs are ephemeral)
    this.context.logs.push({ level, timestamp: new Date(), message });

    // Check if we should actually output this log based on level
    if (this.levelNumber > TagLogger.levels[level]) return;

    // For warn and error, include debug memories
    const debugMemories =
      level === "warn" || level === "error" ? this.context.debugMemories : undefined;

    // For error level, include the full error object if present
    const errorObject = level === "error" && args[0] instanceof Error ? args[0] : undefined;

    // Copy metadata to prevent mutations from affecting logged values
    const metadataCopy = { ...this.context.metadata };

    this._implementation[level]({
      message,
      metadata: metadataCopy,
      debugMemories,
      errorObject,
    });
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
  runInContext<T>(metadata: TagLogger.Context["metadata"], fn: () => T): T {
    const existingContext = this._storage.getStore();
    // Create a shallow copy of metadata to prevent mutations from affecting the original
    const newContext: TagLogger.Context = existingContext
      ? { ...existingContext, metadata: { ...metadata }, logs: [], debugMemories: [] }
      : { level: "info", metadata: { ...metadata }, logs: [], debugMemories: [] };
    return this._storage.run(newContext, fn);
  }

  // Note: enterWith is not supported in Cloudflare Workers
  // Use runInContext or getOrCreateContext instead

  /** Check if we're currently in a context */
  hasContext(): boolean {
    return this._storage.getStore() !== undefined;
  }

  /** Run function, only creating context if one doesn't exist */
  getOrCreateContext<T>(metadata: TagLogger.Context["metadata"], fn: () => T): T {
    if (this.hasContext()) {
      return fn();
    }
    return this.runInContext(metadata, fn);
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

    // Track error with posthog (built-in, noop in test mode)
    this._trackError(errorToLog);

    this._log({ level: "error", args: [errorToLog] });
  }

  private _trackError(error: Error) {
    // Skip error tracking in test mode
    if (import.meta.env.MODE === "test") {
      return;
    }

    waitUntil(
      (async () => {
        try {
          const { PostHog } = await import("posthog-node");
          const { env } = await import("../env.ts");

          const posthog = new PostHog(env.POSTHOG_PUBLIC_KEY, {
            host: "https://eu.i.posthog.com",
          });

          posthog.captureException(error, this.context.metadata.userId, {
            environment: env.POSTHOG_ENVIRONMENT,
            ...this.context.metadata,
          });

          await posthog.shutdown();
        } catch (trackingError) {
          // Silently fail if error tracking fails
          console.error("Failed to track error:", trackingError);
        }
      })(),
    );
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
 *     }));
 *   }
 * }
 * ```
 */
export function withLoggerContext<T extends object>(
  target: T,
  loggerInstance: TagLogger,
  getMetadata: (methodName: string, args: unknown[]) => TagLogger.Context["metadata"],
): T {
  return new Proxy(target, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // If it's not a function, return as-is
      if (typeof value !== "function") {
        return value;
      }

      // Wrap the function with logger context
      return (...args: unknown[]) => {
        const metadata = getMetadata(String(prop), args);
        return loggerInstance.getOrCreateContext(metadata, () => value.apply(target, args));
      };
    },
  });
}

function serializeError(error: unknown): any {
  if (error instanceof Error) {
    const plain: any = {
      name: error.name,
      message: error.message,
    };

    // Include cause if present (recursively serialize it)
    if (error.cause) {
      plain.cause = serializeError(error.cause);
    }

    // Include any additional enumerable properties
    Object.getOwnPropertyNames(error).forEach((key) => {
      if (!plain[key] && key !== "stack") {
        plain[key] = (error as any)[key];
      }
    });

    return plain;
  }
  return error;
}

const replacer = (_: string, value: unknown) => serializeError(value);

/* eslint-disable no-console -- this is the one place where we use console */
export const logger = new TagLogger({
  debug: ({ message, metadata }) =>
    console.debug(JSON.stringify({ message, ...metadata }, replacer)),
  info: ({ message, metadata }) => console.info(JSON.stringify({ message, ...metadata }, replacer)),
  warn: ({ message, metadata, debugMemories }) =>
    console.warn(JSON.stringify({ message, ...metadata, debugMemories }, replacer)),
  error: ({ message, metadata, debugMemories, errorObject }) =>
    console.error(
      JSON.stringify({ message, ...metadata, debugMemories, error: errorObject }, replacer),
    ),
});
