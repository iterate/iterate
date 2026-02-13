import { AsyncLocalStorage } from "node:async_hooks";
import { log, type RequestLogger } from "evlog";
import { createWorkersLogger, initWorkersLogger } from "evlog/workers";

const appStage = process.env.VITE_APP_STAGE || process.env.APP_STAGE || process.env.NODE_ENV;

type LogLevel = "debug" | "info" | "warn" | "error";
type LogEvent = Record<string, unknown>;

const requestLoggerStorage = new AsyncLocalStorage<RequestLogger<LogEvent>>();

initWorkersLogger({
  env: {
    service: "os-backend",
    environment: appStage ?? "development",
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) return serializeError(value, seen);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));
  if (!isRecord(value)) return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const sanitized = Object.fromEntries(
    Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .map(([key, nestedValue]) => [key, sanitizeValue(nestedValue, seen)]),
  );

  seen.delete(value);
  return sanitized;
}

function serializeError(error: Error, seen = new WeakSet<object>()): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };

  const structuredErrorKeys = [
    "code",
    "status",
    "statusCode",
    "statusMessage",
    "data",
    "why",
    "fix",
    "link",
    "cause",
  ] as const;

  for (const key of structuredErrorKeys) {
    const value = error[key as keyof Error];
    if (value !== undefined) serialized[key] = sanitizeValue(value, seen);
  }

  for (const [key, value] of Object.entries(error)) {
    if (serialized[key] === undefined && value !== undefined) {
      serialized[key] = sanitizeValue(value, seen);
    }
  }

  return serialized;
}

function toRequestContext(level: LogLevel, event: LogEvent): LogEvent {
  return Object.fromEntries(
    Object.entries(event).filter(([key, value]) => {
      if (value === undefined) return false;
      if (key === "args") return false;
      if (level !== "error" && key === "message") return false;
      if (level !== "error" && key === "error") return false;
      return true;
    }),
  );
}

function appendBoundedList(existing: unknown, value: unknown, limit: number): unknown[] {
  const list = Array.isArray(existing) ? existing : [];
  return [...list, value].slice(-limit);
}

function normalizeLogArgs(args: unknown[]): { event: LogEvent; error?: Error } {
  const event: LogEvent = {};
  const extraArgs: unknown[] = [];
  let error: Error | undefined;

  for (const arg of args) {
    if (typeof arg === "string") {
      if (typeof event.message !== "string") {
        event.message = arg;
      } else {
        extraArgs.push(arg);
      }
      continue;
    }

    if (arg instanceof Error) {
      error = arg;
      continue;
    }

    if (isRecord(arg)) {
      Object.assign(event, sanitizeValue(arg));
      continue;
    }

    extraArgs.push(sanitizeValue(arg));
  }

  if (extraArgs.length > 0) event.args = extraArgs;
  if (error) event.error = serializeError(error);
  if (!event.message && !event.error && !event.args) event.message = "log";

  return { event, error };
}

function emit(level: LogLevel, args: unknown[]): void {
  const requestLogger = requestLoggerStorage.getStore();
  const { event, error } = normalizeLogArgs(args);

  if (requestLogger) {
    if (level === "error") {
      requestLogger.error(
        error ?? new Error(typeof event.message === "string" ? event.message : "error"),
        toRequestContext(level, event),
      );
    } else {
      const requestContext = toRequestContext(level, event);
      if (typeof event.message === "string") {
        const currentContext = requestLogger.getContext();
        requestContext.events = appendBoundedList(
          currentContext.events,
          `${level}:${event.message}`,
          20,
        );
      }
      if (level === "warn" && typeof event.message === "string") {
        requestContext.warnings = appendBoundedList(
          requestLogger.getContext().warnings,
          event.message,
          10,
        );
      }
      if (Object.keys(requestContext).length > 0) requestLogger.set(requestContext);
    }
    return;
  }

  log[level](event);
}

export function withRequestLogger<T>(request: Request, callback: () => T): T {
  const requestLogger = createWorkersLogger<LogEvent>(request);
  return requestLoggerStorage.run(requestLogger, callback);
}

export function emitRequestLog(overrides: LogEvent = {}): void {
  requestLoggerStorage.getStore()?.emit(overrides);
}

export const logger = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};
