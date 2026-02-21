import { log as rootLog } from "evlog";
import { getRequestEvlogStore, log as requestLog, recordRequestEvlogError } from "./evlog.ts";

type LogLevel = "debug" | "error";

const MAX_REQUEST_LOG_CONTEXT_LENGTH = 1200;

function toContextRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function toMessagePart(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function buildLogParts(args: unknown[]): {
  message: string;
  context: Record<string, unknown>;
  embeddedError?: Error;
} {
  const context: Record<string, unknown> = {};
  const messageParts: string[] = [];
  let embeddedError: Error | undefined;

  for (const arg of args) {
    if (arg instanceof Error) {
      embeddedError ??= arg;
      continue;
    }

    const record = toContextRecord(arg);
    if (record) {
      Object.assign(context, record);
      continue;
    }

    messageParts.push(toMessagePart(arg));
  }

  const message =
    messageParts.length > 0
      ? messageParts.join(" ")
      : embeddedError
        ? `${embeddedError.name}: ${embeddedError.message}`
        : "log";

  return { message, context, embeddedError };
}

function stringifyContext(context: Record<string, unknown>): string | undefined {
  if (Object.keys(context).length === 0) return undefined;

  try {
    const serialized = JSON.stringify(context, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
        };
      }
      return value;
    });

    if (!serialized || serialized === "{}") return undefined;
    if (serialized.length <= MAX_REQUEST_LOG_CONTEXT_LENGTH) return serialized;
    return `${serialized.slice(0, MAX_REQUEST_LOG_CONTEXT_LENGTH)}...`;
  } catch {
    return undefined;
  }
}

function withInlineContext(message: string, context: Record<string, unknown>): string {
  const serialized = stringifyContext(context);
  return serialized ? `${message} | ${serialized}` : message;
}

function writeRequestContext(context: unknown): void {
  const record = toContextRecord(context);
  if (!record) return;

  const store = getRequestEvlogStore();
  if (!store || store.flushed) return;

  requestLog.set(record);
}

function writeErrorOrDebugToEvlog(level: LogLevel, args: unknown[]): void {
  const { message, context, embeddedError } = buildLogParts(args);

  if (level === "error") {
    const error = embeddedError ?? new Error(message);
    recordRequestEvlogError(error, { ...context, message });
    return;
  }

  const store = getRequestEvlogStore();
  if (!store || store.flushed) {
    rootLog[level]({ message, ...context });
    return;
  }

  const requestLogMessage = withInlineContext(message, context);
  requestLog.info(`[debug] ${requestLogMessage}`);
}

function writeMessageToEvlog(level: "info" | "warn", message: string): void {
  const store = getRequestEvlogStore();
  if (!store || store.flushed) {
    rootLog[level]({ message });
    return;
  }

  if (level === "warn") {
    requestLog.warn(message);
    return;
  }

  requestLog.info(message);
}

export const logger = {
  set: (context: unknown) => writeRequestContext(context),
  debug: (...args: unknown[]) => writeErrorOrDebugToEvlog("debug", args),
  info: (message: string) => writeMessageToEvlog("info", message),
  warn: (message: string) => writeMessageToEvlog("warn", message),
  error: (...args: unknown[]) => writeErrorOrDebugToEvlog("error", args),
};
