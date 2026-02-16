import { AsyncLocalStorage } from "node:async_hooks";
import { createRequestLogger, log, type RequestLogger } from "evlog";
import { reportRequestErrorToPostHog } from "./evlog-posthog.ts";

type RequestEvlogEvent = Record<string, unknown>;
type EvlogLevel = "debug" | "info" | "warn" | "error";

type PostHogEnv = {
  POSTHOG_PUBLIC_KEY?: string;
  VITE_APP_STAGE?: string;
};

type WaitUntilExecutionContext = {
  waitUntil: (promise: Promise<unknown>) => void;
};

type RequestMetadata = {
  requestId: string;
  method: string;
  path: string;
};

type RequestEvlogContext = {
  logger: RequestLogger<RequestEvlogEvent>;
  env?: PostHogEnv;
  executionCtx?: WaitUntilExecutionContext;
  flushed: boolean;
  waitUntilSequence: number;
  error?: Error;
};

const requestEvlogStorage = new AsyncLocalStorage<RequestEvlogContext>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getRequestMetadata(logger: RequestLogger<RequestEvlogEvent>): RequestMetadata {
  const context = logger.getContext();
  const nestedRequest = isRecord(context.request) ? context.request : undefined;

  return {
    requestId:
      getString(context.requestId) ??
      (nestedRequest ? getString(nestedRequest.id) : undefined) ??
      crypto.randomUUID(),
    method:
      getString(context.method) ??
      (nestedRequest ? getString(nestedRequest.method) : undefined) ??
      "UNKNOWN",
    path:
      getString(context.path) ??
      (nestedRequest ? getString(nestedRequest.path) : undefined) ??
      "unknown",
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function appendBoundedStringList(current: unknown, next: string, limit: number): string[] {
  return [...toStringList(current), next].slice(-limit);
}

export function withRequestEvlogContext<T>(
  options: {
    logger: RequestLogger<RequestEvlogEvent>;
    env?: PostHogEnv;
    executionCtx?: WaitUntilExecutionContext;
  },
  callback: () => T,
): T {
  return requestEvlogStorage.run(
    {
      logger: options.logger,
      env: options.env,
      executionCtx: options.executionCtx,
      flushed: false,
      waitUntilSequence: 0,
    },
    callback,
  );
}

export function setRequestEvlogContext(context: RequestEvlogEvent): void {
  requestEvlogStorage.getStore()?.logger.set(context);
}

export function recordRequestEvlogError(error: unknown, context: RequestEvlogEvent = {}): void {
  const store = requestEvlogStorage.getStore();
  const resolvedError = toError(error);

  if (!store || store.flushed) {
    log.error({
      ...context,
      error: {
        name: resolvedError.name,
        message: resolvedError.message,
        stack: resolvedError.stack,
      },
    });
    return;
  }

  store.error = resolvedError;
  store.logger.error(resolvedError, context);

  const currentContext = store.logger.getContext();
  const nextMessage = `${resolvedError.name}: ${resolvedError.message}`;
  store.logger.set({
    errors: appendBoundedStringList(currentContext.errors, nextMessage, 100),
  });
}

export function appendRequestEvlogMessage(level: EvlogLevel, message: string): void {
  const store = requestEvlogStorage.getStore();
  const contextKey =
    level === "warn"
      ? "warnings"
      : level === "debug"
        ? "debugMessages"
        : level === "error"
          ? "errors"
          : "messages";

  if (!store || store.flushed) {
    log[level]({
      [contextKey]: [message],
    });
    return;
  }

  const currentContext = store.logger.getContext();
  store.logger.set({
    [contextKey]: appendBoundedStringList(currentContext[contextKey], message, 200),
  });
}

export function flushRequestEvlog(overrides: RequestEvlogEvent = {}): void {
  const store = requestEvlogStorage.getStore();
  if (!store || store.flushed) return;

  store.flushed = true;
  const event = store.logger.emit(overrides);
  if (!event || !store.error || !store.env?.POSTHOG_PUBLIC_KEY) return;

  const report = reportRequestErrorToPostHog({
    env: store.env,
    error: store.error,
    event,
  }).catch(() => undefined);

  if (store.executionCtx) {
    store.executionCtx.waitUntil(report);
    return;
  }

  void report;
}

export function wrapWaitUntilWithEvlog<T>(promise: Promise<T>): Promise<T> {
  const parentContext = requestEvlogStorage.getStore();
  if (!parentContext) return promise;

  const parentMetadata = getRequestMetadata(parentContext.logger);
  const parentLoggerContext = parentContext.logger.getContext();

  const nextSequence = parentContext.waitUntilSequence + 1;
  parentContext.waitUntilSequence = nextSequence;

  const waitUntilPath = `${parentMetadata.path}#waitUntil`;
  const waitUntilRequestId = `${parentMetadata.requestId}:waitUntil:${nextSequence}`;

  const waitUntilLogger = createRequestLogger<RequestEvlogEvent>({
    method: parentMetadata.method,
    path: waitUntilPath,
    requestId: waitUntilRequestId,
  });

  waitUntilLogger.set({
    request: {
      id: waitUntilRequestId,
      method: parentMetadata.method,
      path: waitUntilPath,
      status: 500,
      duration: 0,
      waitUntil: true,
      parentRequestId: parentMetadata.requestId,
    },
    ...(isRecord(parentLoggerContext.user) ? { user: parentLoggerContext.user } : {}),
    waitUntil: true,
    parentRequestId: parentMetadata.requestId,
  });

  return withRequestEvlogContext(
    {
      logger: waitUntilLogger,
      env: parentContext.env,
      executionCtx: parentContext.executionCtx,
    },
    async () => {
      let status = 200;
      try {
        return await promise;
      } catch (error) {
        status = 500;
        recordRequestEvlogError(error, {
          waitUntil: true,
          parentRequestId: parentMetadata.requestId,
          status,
        });
        throw error;
      } finally {
        flushRequestEvlog({
          waitUntil: true,
          parentRequestId: parentMetadata.requestId,
          status,
        });
      }
    },
  );
}
