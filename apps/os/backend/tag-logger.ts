import {
  appendRequestEvlogMessage,
  recordRequestEvlogError,
  setRequestEvlogContext,
} from "./evlog.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

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
  const message = args.length === 0 ? "log" : args.map((arg) => toMessagePart(arg)).join(" ");
  const context: Record<string, unknown> = {};
  let embeddedError: Error | undefined;

  for (const arg of args) {
    if (arg instanceof Error) {
      embeddedError ??= arg;
      continue;
    }
    if (!arg || typeof arg !== "object" || Array.isArray(arg)) continue;

    const record = arg as Record<string, unknown>;
    Object.assign(context, record);
    for (const key of ["error", "err", "cause"] as const) {
      const candidate = record[key];
      if (candidate instanceof Error) {
        embeddedError ??= candidate;
      }
    }
  }

  return { message, context, embeddedError };
}

function writeToEvlog(level: LogLevel, args: unknown[]): void {
  const { message, context, embeddedError } = buildLogParts(args);

  if (Object.keys(context).length > 0) {
    setRequestEvlogContext(context);
  }

  if (level === "error") {
    const error = embeddedError ?? new Error(message);
    recordRequestEvlogError(error, { ...context, message });
    return;
  }

  appendRequestEvlogMessage(level, message);
}
export const logger = {
  debug: (...args: unknown[]) => writeToEvlog("debug", args),
  info: (...args: unknown[]) => writeToEvlog("info", args),
  warn: (...args: unknown[]) => writeToEvlog("warn", args),
  error: (...args: unknown[]) => writeToEvlog("error", args),
};
