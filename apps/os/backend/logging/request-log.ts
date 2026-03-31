/*
 * Inspired by loggingsucks.com and evlog.dev.
 * apps/os keeps the wide-event idea, but the implementation is intentionally
 * plain: mutable request-scoped records, explicit sinks, and convention-based
 * context like `request` and `outbox`.
 */

import util from "node:util";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
  ) as T;
}

export function mergeLogRecords(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;

    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = { ...current, ...value };
      continue;
    }

    result[key] = cloneValue(value);
  }

  return result;
}

export function appendParsedError(
  event: Record<string, unknown>,
  error: { name: string; message: string; stack?: string; cause?: unknown },
): Record<string, unknown> {
  const errors = Array.isArray(event.errors) ? [...event.errors] : [];
  errors.push(error);
  return { ...event, errors };
}

export function toParsedLogError(
  error: unknown,
  fallbackMessage?: string,
): {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  [key: string]: unknown;
} {
  if (error instanceof Error) {
    const extraEntries = Object.entries(error).filter(
      ([key]) => !["name", "message", "stack", "cause"].includes(key),
    );

    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...("cause" in error ? { cause: (error as Error & { cause?: unknown }).cause } : {}),
      ...Object.fromEntries(extraEntries),
    };
  }

  return {
    name: "NonErrorThrowable",
    message: fallbackMessage ?? String(error),
    stack: new Error(fallbackMessage ?? String(error)).stack,
  };
}

export function inspectValue(value: unknown): string {
  const inspected = util.inspect(value, {
    depth: 4,
    colors: true,
    compact: true,
    breakLength: 80,
    maxArrayLength: 20,
    maxStringLength: 300,
  });
  if (inspected.includes("\n")) {
    return inspected.replace(/^{ /, "{\n  ").replaceAll("\n", "\n  ");
  }
  return inspected;
}
