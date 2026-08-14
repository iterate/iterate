import { AsyncLocalStorage } from "node:async_hooks";

const MAX_MESSAGES = 20;
const semanticValue = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;

/**
 * Cloudflare caps all console output for one request at 256 KiB. ITX can keep
 * one request open for a long time, so each logical call gets a deliberately
 * tiny event rather than sharing one ever-growing session payload.
 *
 * https://developers.cloudflare.com/workers/platform/limits/#log-size
 */
export const MAX_WIDE_LOG_BYTES = 4 * 1_024;

export type WideLogFields = {
  auth?: {
    sessionVerificationFailure: {
      reason: string;
      errorType: string;
      issuerHost?: string;
      clientId?: string;
      jwksKeyIds?: string[];
    };
  };
  ingress?: {
    lane: string;
    transport?: "http" | "websocket";
    projectId?: string;
    appSlug?: string;
  };
  itx?: {
    callId?: string;
    method?: string;
    rpcSystem?: "capnweb";
    sessionId: string;
    transport?: "http" | "websocket";
  };
  mcpAuth?: {
    opaqueIntrospection?: string;
    opaqueIntrospectionErrorType?: string;
  };
};

export type WideLogEvent = WideLogFields & {
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
  messages?: Array<{ level: "info" | "warn"; message: string; elapsedMs: number }>;
  error?: { name: string; cause?: WideLogEvent["error"] };
  dropped?: { messages?: number; eventBytes?: number };
};

type WideLogStore = {
  event: WideLogEvent;
  finalized: boolean;
  startedAt: number;
};

export type WideLogger = {
  id(): string;
  set(fields: WideLogFields): void;
  setOutcome(outcome: string): void;
  setOutcomeIfUnknown(outcome: string): void;
  info(message: string, fields?: WideLogFields): void;
  warn(message: string, fields?: WideLogFields): void;
};

const storage = new AsyncLocalStorage<WideLogStore>();

function currentStore(action: string): WideLogStore {
  const store = storage.getStore();
  if (!store) throw new Error(`Logging outside runWideLog(...) is illegal (${action})`);
  return store;
}

function mutableStore(action: string): WideLogStore | undefined {
  const store = currentStore(action);
  // Async resources retain ALS context after the operation ends. A completed
  // event is immutable; background work must open its own runWideLog child.
  return store.finalized ? undefined : store;
}

function safeSemanticValue(value: string, fallback: string) {
  return semanticValue.test(value) ? value : fallback;
}

function serializeError(error: unknown, depth = 0, seen = new Set<Error>()): WideLogEvent["error"] {
  if (!(error instanceof Error)) return { name: "NonErrorThrowable" };
  const serialized: NonNullable<WideLogEvent["error"]> = { name: "Error" };
  if (depth >= 3 || seen.has(error) || !(error.cause instanceof Error)) return serialized;
  seen.add(error);
  serialized.cause = serializeError(error.cause, depth + 1, seen);
  return serialized;
}

function setFields(fields: WideLogFields) {
  const store = mutableStore("set");
  if (store) Object.assign(store.event, fields);
}

function appendMessage(level: "info" | "warn", message: string, fields?: WideLogFields) {
  const store = mutableStore(level);
  if (!store) return;
  if (fields) Object.assign(store.event, fields);
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
    message: safeSemanticValue(message, "redacted_non_semantic_message"),
    elapsedMs: Math.max(0, Date.now() - store.startedAt),
  });
  store.event.messages = messages;
}

export const wideLogger: WideLogger = {
  id: () => currentStore("id").event.log.id,
  set: setFields,
  setOutcome: (outcome) => {
    const store = mutableStore("setOutcome");
    if (store) store.event.outcome = safeSemanticValue(outcome, "unknown");
  },
  setOutcomeIfUnknown: (outcome) => {
    const store = mutableStore("setOutcomeIfUnknown");
    if (store?.event.outcome === "unknown") {
      store.event.outcome = safeSemanticValue(outcome, "unknown");
    }
  },
  info: (message, fields) => appendMessage("info", message, fields),
  warn: (message, fields) => appendMessage("warn", message, fields),
};

function boundedEvent(event: WideLogEvent): WideLogEvent {
  const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
  if (eventBytes <= MAX_WIDE_LOG_BYTES) return event;
  return {
    schema: event.schema,
    message: event.message,
    log: event.log,
    outcome: event.outcome,
    ...(event.error && { error: event.error }),
    dropped: { eventBytes },
  };
}

/** Logging is diagnostic: it must never change the product operation's result. */
function emit(store: WideLogStore) {
  try {
    const event = boundedEvent(store.event);
    if (event.outcome === "error" || event.outcome === "server_error") console.error(event);
    else console.log(event);
  } catch {
    try {
      console.error({
        schema: "iterate.wide-log.v1",
        message: "wide_log_emission_failed",
        log: store.event.log,
        outcome: "error",
      });
    } catch {
      return;
    }
  }
}

/** Runs one logical operation and emits one compact structured event at exit. */
export async function runWideLog<T>(
  options: {
    kind: string;
    fields?: WideLogFields;
    parentId?: string;
    /** Classify an expected thrown outcome without turning it into an error log. */
    classifyError?: (error: unknown) => string | undefined;
  },
  run: () => T | Promise<T>,
): Promise<T> {
  const parentId = options.parentId ?? storage.getStore()?.event.log.id;
  const startedAt = Date.now();
  const kind = safeSemanticValue(options.kind, "operation");
  const store: WideLogStore = {
    event: {
      schema: "iterate.wide-log.v1",
      message: kind,
      log: {
        id: `log_${crypto.randomUUID().replaceAll("-", "")}`,
        kind,
        ...(parentId && { parentId }),
        start: new Date(startedAt).toISOString(),
      },
      outcome: "unknown",
      ...options.fields,
    },
    finalized: false,
    startedAt,
  };

  return storage.run(store, async () => {
    try {
      const result = await run();
      if (store.event.outcome === "unknown") store.event.outcome = "ok";
      return result;
    } catch (error) {
      store.event.error = serializeError(error);
      store.event.outcome = safeSemanticValue(options.classifyError?.(error) ?? "error", "error");
      throw error;
    } finally {
      const endedAt = Date.now();
      store.event.log.end = new Date(endedAt).toISOString();
      store.event.log.durationMs = Math.max(0, endedAt - startedAt);
      store.finalized = true;
      emit(store);
    }
  });
}
