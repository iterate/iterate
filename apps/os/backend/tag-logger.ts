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
      rawArgs: unknown[];
    }) => void
  >;
}

// Re-export a helpful metadata type for consumers
export type LoggerMetadata = TagLogger.Context["metadata"];

// Symbol key to store durable-object-scoped base metadata on the instance
export const LOGGER_METADATA_KEY: symbol = Symbol.for("iterate.logger.base_metadata");

/**
 * Get the instance's base logger metadata, creating it if missing.
 * Stored as a non-enumerable property to avoid interfering with iteration/serialization.
 */
export function getInstanceLoggerMetadata(target: object): LoggerMetadata {
  const anyTarget = target as Record<PropertyKey, unknown>;
  let base = anyTarget[LOGGER_METADATA_KEY] as LoggerMetadata | undefined;
  if (!base) {
    base = {
      userId: undefined,
      traceId: "",
    } satisfies LoggerMetadata;
    Object.defineProperty(anyTarget, LOGGER_METADATA_KEY, {
      value: base,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  return base;
}

/** Merge new values into the instance's base logger metadata */
export function setInstanceLoggerMetadata(target: object, partial: Partial<LoggerMetadata>): void {
  const base = getInstanceLoggerMetadata(target);
  Object.assign(base, partial);
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

  getMetadata() {
    return this.context.metadata;
  }

  // todo: get rid of rawArgs, just pass the raw args to args, and get rid of the not-fully-working error transformations
  _log({ level, args, rawArgs }: { level: TagLogger.Level; args: unknown[]; rawArgs?: unknown[] }) {
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
      rawArgs: rawArgs || args,
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
    } else if (args.length === 2 && typeof args[0] === "string") {
      errorToLog = new Error(args[0], { cause: args[1] });
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
          // Note: We can't use logger here as it would create infinite recursion
          // eslint-disable-next-line no-console -- Cannot use logger here as it would create infinite recursion
          console.error("Failed to track error:", trackingError);
        }
      })(),
    );
  }
}

function serializeError(error: unknown): any {
  if (error instanceof Error) {
    const plain: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
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

const dumpMetadata = (metadata: Record<string, unknown>) =>
  Object.entries(metadata)
    .map(([key, value]) => `[${key}=${value}]`)
    .join("");

/* eslint-disable no-console -- this is the one place where we use console */
export const devConsoleImplementation: TagLogger.Implementation = {
  debug: ({ rawArgs, metadata }) => console.debug(dumpMetadata(metadata), ...rawArgs),
  info: ({ rawArgs, metadata }) => console.info(dumpMetadata(metadata), ...rawArgs),
  warn: ({ rawArgs, metadata }) => console.warn(dumpMetadata(metadata), ...rawArgs),
  error: ({ rawArgs, metadata }) => console.error(dumpMetadata(metadata), ...rawArgs),
};

export const consoleImplementation: TagLogger.Implementation = {
  debug: ({ message, metadata }) =>
    console.debug(JSON.stringify({ message, ...metadata }, replacer)),
  info: ({ message, metadata }) => console.info(JSON.stringify({ message, ...metadata }, replacer)),
  warn: ({ message, metadata, debugMemories }) =>
    console.warn(JSON.stringify({ message, ...metadata, debugMemories }, replacer)),
  error: ({ message, metadata, debugMemories, errorObject }) =>
    console.error(
      JSON.stringify({ message, ...metadata, debugMemories, error: errorObject }, replacer),
    ),
};

export const logger = new TagLogger(
  import.meta.env.MODE === "development" ? devConsoleImplementation : consoleImplementation,
);
