import { AsyncLocalStorage } from "node:async_hooks";

const MAX_MESSAGES = 50;
const MAX_ERRORS = 8;
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_FIELD_STRING_LENGTH = 4_000;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_FIELD_DEPTH = 6;
export const MAX_WIDE_LOG_BYTES = 128 * 1_024;

const REDACTED_MESSAGE = "redacted_non_semantic_message";
const semanticMessage = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;

const sensitiveKey =
  /authorization|headers?|cookie|secret|password|passphrase|api[-_]?key|token|body|prompt|script|arguments?|result|email/i;

export type WideLogLevel = "debug" | "info" | "warn" | "error";

export type WideLogEvent = {
  schema: "iterate.wide-log.v1";
  message: string;
  log: {
    id: string;
    kind: string;
    parentId?: string;
    start: string;
    end?: string;
    durationMs?: number;
  };
  outcome: string;
  messages?: Array<{ level: WideLogLevel; message: string; elapsedMs: number }>;
  errors?: Array<Record<string, unknown>>;
  dropped?: { messages?: number; errors?: number; fields?: number; eventBytes?: number };
  [key: string]: unknown;
};

export type WideLogSinkContext = {
  originalErrors: readonly unknown[];
};

export type WideLogSink = (
  event: WideLogEvent,
  context: WideLogSinkContext,
) => void | Promise<void>;

type WideLogStore = {
  event: WideLogEvent;
  originalErrors: unknown[];
  sinks: readonly WideLogSink[];
  waitUntil?: (promise: Promise<unknown>) => void;
  startedAt: number;
};

export type WideLogger = {
  get(): WideLogEvent;
  peek(): WideLogEvent | undefined;
  set(fields: Record<string, unknown>): void;
  setOutcome(outcome: string): void;
  setSummary(message: string): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(error: unknown, fields?: Record<string, unknown>): void;
};

const storage = new AsyncLocalStorage<WideLogStore>();

function currentStore(action: string): WideLogStore {
  const store = storage.getStore();
  if (!store) throw new Error(`Logging outside runWideLog(...) is illegal (${action})`);
  return store;
}

function cloneEvent(event: WideLogEvent): WideLogEvent {
  return structuredClone(event);
}

function clip(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function safeSemanticMessage(value: string) {
  return semanticMessage.test(value) ? value : REDACTED_MESSAGE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeValue(
  value: unknown,
  options: { depth?: number; seen?: WeakSet<object>; key?: string } = {},
): unknown {
  const depth = options.depth ?? 0;
  if (options.key && sensitiveKey.test(options.key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return clip(value, MAX_FIELD_STRING_LENGTH);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return `${value.origin}${value.pathname}`;
  if (value instanceof Error) return serializeError(value, depth, options.seen);
  if (depth >= MAX_FIELD_DEPTH) return "[TRUNCATED]";

  const seen = options.seen ?? new WeakSet<object>();
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => safeValue(item, { depth: depth + 1, seen }));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    const safe = safeValue(item, { depth: depth + 1, seen, key });
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

function serializeError(
  error: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { name: "NonErrorThrowable" };
  }

  const serialized: Record<string, unknown> = {
    name: safeSemanticMessage(error.name),
  };
  if (depth >= 3 || seen.has(error)) return serialized;
  seen.add(error);

  if (error.cause !== undefined) serialized.cause = serializeError(error.cause, depth + 1, seen);
  for (const key of ["code", "status", "statusCode", "kind", "type"] as const) {
    const value = Reflect.get(error, key);
    if (typeof value === "number" || typeof value === "boolean") serialized[key] = value;
    if (typeof value === "string") serialized[key] = safeSemanticMessage(value);
  }
  return serialized;
}

function mergeRecords(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? mergeRecords(current, value) : value;
  }
  return result;
}

function setFields(fields: Record<string, unknown>) {
  const store = currentStore("set");
  const safe = safeValue(fields);
  if (!isRecord(safe)) return;

  const {
    schema: _schema,
    log: _log,
    message: _message,
    outcome: _outcome,
    messages: _messages,
    errors: _errors,
    dropped: _dropped,
    ...patch
  } = safe;
  store.event = mergeRecords(store.event, patch) as WideLogEvent;
}

function appendMessage(level: WideLogLevel, message: string, fields?: Record<string, unknown>) {
  const store = currentStore(level);
  if (fields) setFields(fields);
  const messages = store.event.messages ?? [];
  if (messages.length >= MAX_MESSAGES) {
    store.event.dropped = {
      ...store.event.dropped,
      messages: (store.event.dropped?.messages ?? 0) + 1,
    };
    return;
  }
  messages.push({
    level,
    message: safeSemanticMessage(message),
    elapsedMs: Math.max(0, Date.now() - store.startedAt),
  });
  store.event.messages = messages;
}

function appendError(error: unknown) {
  const store = currentStore("error");
  if (store.originalErrors.some((recorded) => Object.is(recorded, error))) return;
  const errors = store.event.errors ?? [];
  if (errors.length >= MAX_ERRORS) {
    store.event.dropped = {
      ...store.event.dropped,
      errors: (store.event.dropped?.errors ?? 0) + 1,
    };
    return;
  }
  store.originalErrors.push(error);
  errors.push(serializeError(error));
  store.event.errors = errors;
}

export const wideLogger: WideLogger = {
  get: () => cloneEvent(currentStore("get").event),
  peek: () => {
    const store = storage.getStore();
    return store ? cloneEvent(store.event) : undefined;
  },
  set: setFields,
  setOutcome: (outcome) => {
    currentStore("setOutcome").event.outcome = safeSemanticMessage(outcome);
  },
  setSummary: (message) => {
    currentStore("setSummary").event.message = clip(message, MAX_MESSAGE_LENGTH);
  },
  debug: (message, fields) => appendMessage("debug", message, fields),
  info: (message, fields) => appendMessage("info", message, fields),
  warn: (message, fields) => appendMessage("warn", message, fields),
  error: (error, fields) => {
    if (fields) setFields(fields);
    appendError(error);
    appendMessage("error", `error.${error instanceof Error ? error.name : "NonErrorThrowable"}`);
  },
};

function encodedBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedEvent(event: WideLogEvent): WideLogEvent {
  const eventBytes = encodedBytes(event);
  if (eventBytes <= MAX_WIDE_LOG_BYTES) return event;

  const bounded: WideLogEvent = {
    schema: event.schema,
    message: event.message,
    log: event.log,
    outcome: event.outcome,
    ...Object.fromEntries(
      ["service", "deployment", "http", "ingress", "itx", "cloudflare", "project", "user"]
        .filter((key) => event[key] !== undefined)
        .map((key) => [key, event[key]]),
    ),
    ...(event.messages ? { messages: [...event.messages] } : {}),
    ...(event.errors ? { errors: [...event.errors] } : {}),
    dropped: { ...event.dropped, fields: 1, eventBytes },
  };

  while (encodedBytes(bounded) > MAX_WIDE_LOG_BYTES && bounded.messages?.length) {
    bounded.messages.pop();
    bounded.dropped = {
      ...bounded.dropped,
      messages: (bounded.dropped?.messages ?? 0) + 1,
    };
  }
  while (encodedBytes(bounded) > MAX_WIDE_LOG_BYTES && bounded.errors?.length) {
    bounded.errors.pop();
    bounded.dropped = { ...bounded.dropped, errors: (bounded.dropped?.errors ?? 0) + 1 };
  }
  for (const key of ["user", "project", "cloudflare", "ingress", "http", "deployment", "service"]) {
    if (encodedBytes(bounded) <= MAX_WIDE_LOG_BYTES) break;
    delete bounded[key];
    bounded.dropped = { ...bounded.dropped, fields: (bounded.dropped?.fields ?? 0) + 1 };
  }

  if (encodedBytes(bounded) <= MAX_WIDE_LOG_BYTES) return bounded;
  return {
    schema: event.schema,
    message: clip(event.message, 200),
    log: event.log,
    outcome: event.outcome,
    dropped: { fields: Object.keys(event).length, eventBytes },
  };
}

function reportSinkError(store: WideLogStore, sink: WideLogSink, error: unknown) {
  console.error({
    event: "wide_log_sink_error",
    operationId: store.event.log.id,
    operationKind: store.event.log.kind,
    sink: sink.name || "anonymous",
    error: serializeError(error),
  });
}

async function emit(store: WideLogStore) {
  const context: WideLogSinkContext = { originalErrors: store.originalErrors };
  const event = boundedEvent(store.event);
  for (const sink of store.sinks) {
    try {
      const result = sink(cloneEvent(event), context);
      if (
        !result ||
        (typeof result !== "object" && typeof result !== "function") ||
        typeof Reflect.get(result, "then") !== "function"
      ) {
        continue;
      }
      const task = Promise.resolve(result).catch((error) => reportSinkError(store, sink, error));
      if (store.waitUntil) {
        try {
          store.waitUntil(task);
        } catch (error) {
          reportSinkError(store, sink, error);
        }
      } else {
        await task;
      }
    } catch (error) {
      reportSinkError(store, sink, error);
    }
  }
}

/**
 * Runs one bounded logical operation and emits one accumulated event at exit.
 * Nested operations inherit only the parent's id, never its payload.
 */
export async function runWideLog<T>(
  options: {
    kind: string;
    fields?: Record<string, unknown>;
    parentId?: string;
    sinks?: readonly WideLogSink[];
    waitUntil?: (promise: Promise<unknown>) => void;
  },
  run: () => T | Promise<T>,
): Promise<T> {
  const parent = storage.getStore();
  const parentId = options.parentId ?? parent?.event.log.id;
  const startedAt = Date.now();
  const safeFields = safeValue(options.fields ?? {});
  const {
    schema: _schema,
    log: _log,
    message: _message,
    outcome: _outcome,
    messages: _messages,
    errors: _errors,
    dropped: _dropped,
    ...initialFields
  } = isRecord(safeFields) ? safeFields : {};
  const store: WideLogStore = {
    event: {
      schema: "iterate.wide-log.v1",
      message: safeSemanticMessage(options.kind),
      log: {
        id: `log_${crypto.randomUUID().replaceAll("-", "")}`,
        kind: safeSemanticMessage(options.kind),
        ...(parentId ? { parentId } : {}),
        start: new Date(startedAt).toISOString(),
      },
      outcome: "unknown",
      ...initialFields,
    },
    originalErrors: [],
    sinks: options.sinks ?? parent?.sinks ?? [],
    waitUntil: options.waitUntil ?? parent?.waitUntil,
    startedAt,
  };

  return storage.run(store, async () => {
    try {
      const result = await run();
      if (store.event.outcome === "unknown") store.event.outcome = "ok";
      return result;
    } catch (error) {
      appendError(error);
      store.event.outcome = "error";
      throw error;
    } finally {
      const endedAt = Date.now();
      store.event.log.end = new Date(endedAt).toISOString();
      store.event.log.durationMs = Math.max(0, endedAt - startedAt);
      await emit(store);
    }
  });
}
