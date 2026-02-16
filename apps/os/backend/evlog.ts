import { AsyncLocalStorage } from "node:async_hooks";
import { createRequestLogger, initLogger, log, type RequestLogger, type WideEvent } from "evlog";
import { sendPostHogException } from "./lib/posthog.ts";

const appStage =
  process.env.VITE_APP_STAGE ?? process.env.APP_STAGE ?? process.env.NODE_ENV ?? "development";

type RequestEvlogEvent = Record<string, unknown>;
type EvlogLevel = "debug" | "info" | "warn" | "error";

type PostHogEnv = {
  POSTHOG_PUBLIC_KEY?: string;
  VITE_APP_STAGE?: string;
};

type WaitUntilExecutionContext = {
  waitUntil: (promise: Promise<unknown>) => void;
};

type RequestEvlogContext = {
  logger: RequestLogger<RequestEvlogEvent>;
  env?: PostHogEnv;
  executionCtx?: WaitUntilExecutionContext;
  requestId: string;
  method: string;
  path: string;
  flushed: boolean;
  waitUntilSequence: number;
  error?: Error;
};

const requestEvlogStorage = new AsyncLocalStorage<RequestEvlogContext>();

initLogger({
  env: {
    service: "os-backend",
    environment: appStage,
  },
  stringify: false,
});

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getEventStringField(event: WideEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

function getEventNumberField(event: WideEvent, key: string): number | undefined {
  const value = event[key];
  return typeof value === "number" ? value : undefined;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function appendBoundedStringList(current: unknown, next: string, limit: number): string[] {
  return [...toStringList(current), next].slice(-limit);
}

function getPostHogProperties(event: WideEvent): Record<string, unknown> {
  return {
    method: getEventStringField(event, "method"),
    path: getEventStringField(event, "path"),
    requestId: getEventStringField(event, "requestId"),
    userId: getEventStringField(event, "userId"),
    status: getEventNumberField(event, "status"),
    duration: getEventStringField(event, "duration"),
    waitUntil: event.waitUntil === true,
    parentRequestId: getEventStringField(event, "parentRequestId"),
    trpcProcedure: getEventStringField(event, "trpcProcedure"),
    url: getEventStringField(event, "url"),
  };
}

async function reportErrorToPostHog(
  env: PostHogEnv,
  error: Error,
  event: WideEvent,
): Promise<void> {
  const apiKey = env.POSTHOG_PUBLIC_KEY;
  if (!apiKey) return;

  const distinctId =
    getEventStringField(event, "userId") ?? getEventStringField(event, "requestId") ?? "anonymous";

  await sendPostHogException({
    apiKey,
    distinctId,
    error,
    properties: getPostHogProperties(event),
    environment: env.VITE_APP_STAGE ?? appStage,
    lib: "evlog-worker",
  });
}

function schedulePostHogErrorReport(context: RequestEvlogContext, event: WideEvent): void {
  if (!context.error || !context.env?.POSTHOG_PUBLIC_KEY) return;

  const report = reportErrorToPostHog(context.env, context.error, event).catch(() => undefined);
  if (context.executionCtx) {
    context.executionCtx.waitUntil(report);
    return;
  }
  void report;
}

function getRequestId(request: Request): string {
  return (
    request.headers.get("cf-ray") ?? request.headers.get("x-request-id") ?? crypto.randomUUID()
  );
}

function getRequestPath(request: Request): string {
  return new URL(request.url).pathname;
}

export function withRequestEvlogContext<T>(
  options: {
    request: Request;
    env?: PostHogEnv;
    executionCtx?: WaitUntilExecutionContext;
  },
  callback: () => T,
): T {
  const requestId = getRequestId(options.request);
  const method = options.request.method;
  const path = getRequestPath(options.request);
  const logger = createRequestLogger<RequestEvlogEvent>({
    method,
    path,
    requestId,
  });

  return requestEvlogStorage.run(
    {
      logger,
      env: options.env,
      executionCtx: options.executionCtx,
      requestId,
      method,
      path,
      flushed: false,
      waitUntilSequence: 0,
    },
    callback,
  );
}

export function getRequestEvlogger(): RequestLogger<RequestEvlogEvent> | undefined {
  return requestEvlogStorage.getStore()?.logger;
}

export function setRequestEvlogContext(context: RequestEvlogEvent): void {
  getRequestEvlogger()?.set(context);
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
  if (!event) return;
  schedulePostHogErrorReport(store, event);
}

export function wrapWaitUntilWithEvlog<T>(promise: Promise<T>): Promise<T> {
  const parentContext = requestEvlogStorage.getStore();
  if (!parentContext) return promise;

  const nextSequence = parentContext.waitUntilSequence + 1;
  parentContext.waitUntilSequence = nextSequence;

  const waitUntilPath = `${parentContext.path}#waitUntil`;
  const waitUntilRequestId = `${parentContext.requestId}:waitUntil:${nextSequence}`;
  const waitUntilLogger = createRequestLogger<RequestEvlogEvent>({
    method: parentContext.method,
    path: waitUntilPath,
    requestId: waitUntilRequestId,
  });

  const parentLoggerContext = parentContext.logger.getContext();
  waitUntilLogger.set({
    waitUntil: true,
    parentRequestId: parentContext.requestId,
    ...(typeof parentLoggerContext.userId === "string"
      ? { userId: parentLoggerContext.userId }
      : {}),
  });

  const waitUntilContext: RequestEvlogContext = {
    logger: waitUntilLogger,
    env: parentContext.env,
    executionCtx: parentContext.executionCtx,
    requestId: waitUntilRequestId,
    method: parentContext.method,
    path: waitUntilPath,
    flushed: false,
    waitUntilSequence: 0,
  };

  return requestEvlogStorage.run(waitUntilContext, async () => {
    let status = 200;
    try {
      return await promise;
    } catch (error) {
      status = 500;
      recordRequestEvlogError(error, {
        waitUntil: true,
        parentRequestId: parentContext.requestId,
        status,
      });
      throw error;
    } finally {
      flushRequestEvlog({
        waitUntil: true,
        parentRequestId: parentContext.requestId,
        status,
      });
    }
  });
}
