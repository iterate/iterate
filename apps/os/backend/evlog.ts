import { AsyncLocalStorage } from "node:async_hooks";
import { createRequestLogger, log as rootLog, type RequestLogger, type WideEvent } from "evlog";

export type RequestEvlogEvent = Record<string, unknown>;

type RequestMetadata = {
  requestId: string;
  method: string;
  path: string;
};

type RequestEvlogEnv = {
  POSTHOG_PUBLIC_KEY?: string;
  VITE_APP_STAGE?: string;
};

type WaitUntilExecutionContext = {
  waitUntil: (promise: Promise<unknown>) => void;
};

export type RequestEvlogContext = {
  request: RequestMetadata;
  env?: RequestEvlogEnv;
  executionCtx?: WaitUntilExecutionContext;
  flushed: boolean;
  errors: Error[];
};

export type RequestEvlogFlushPayload = {
  event: WideEvent;
  errors?: Error[];
  env?: RequestEvlogEnv;
  executionCtx?: WaitUntilExecutionContext;
};

export const logStorage = new AsyncLocalStorage<RequestLogger<RequestEvlogEvent>>();
const requestStorage = new AsyncLocalStorage<RequestEvlogContext>();

let flushHandler: ((payload: RequestEvlogFlushPayload) => void | Promise<void>) | undefined;

const getLogger = (): RequestLogger<RequestEvlogEvent> => {
  const logger = logStorage.getStore();
  if (!logger) {
    throw new Error("Logger not found in storage");
  }
  return logger;
};

function getStore(): RequestEvlogContext | undefined {
  return requestStorage.getStore();
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const log: RequestLogger<RequestEvlogEvent> = {
  set: (...args) => getLogger().set(...args),
  error: (...args) => getLogger().error(...args),
  info: (...args) => getLogger().info(...args),
  warn: (...args) => getLogger().warn(...args),
  emit: (...args) => getLogger().emit(...args),
  getContext: () => getLogger().getContext(),
};

export function setRequestEvlogFlushHandler(
  handler?: (payload: RequestEvlogFlushPayload) => void | Promise<void>,
): void {
  flushHandler = handler;
}

export function getRequestEvlogStore(): RequestEvlogContext | undefined {
  return getStore();
}

export function withRequestEvlogContext<T>(
  options: {
    logger: RequestLogger<RequestEvlogEvent>;
    request: RequestMetadata;
    env?: RequestEvlogEnv;
    executionCtx?: WaitUntilExecutionContext;
  },
  callback: () => T,
): T {
  return requestStorage.run(
    {
      request: options.request,
      env: options.env,
      executionCtx: options.executionCtx,
      flushed: false,
      errors: [],
    },
    () => logStorage.run(options.logger, callback),
  );
}

export function recordRequestEvlogError(error: unknown, context: RequestEvlogEvent = {}): void {
  const store = getStore();
  const resolvedError = toError(error);

  if (!store || store.flushed) {
    rootLog.error({
      ...context,
      error: {
        name: resolvedError.name,
        message: resolvedError.message,
        stack: resolvedError.stack,
      },
    });
    return;
  }

  store.errors.push(resolvedError);
  log.error(resolvedError, context);
}

export function flushRequestEvlog(): RequestEvlogFlushPayload | undefined {
  const store = getStore();
  if (!store || store.flushed) return undefined;

  store.flushed = true;
  const event = log.emit();
  if (!event) return undefined;

  const payload: RequestEvlogFlushPayload = {
    event,
    errors: store.errors.length > 0 ? [...store.errors] : undefined,
    env: store.env,
    executionCtx: store.executionCtx,
  };

  if (!flushHandler) return payload;

  const task = Promise.resolve(flushHandler(payload)).catch(() => undefined);
  if (store.executionCtx) {
    store.executionCtx.waitUntil(task);
  } else {
    void task;
  }

  return payload;
}

type WaitUntilTask<T> = Promise<T> | (() => Promise<T>);

function resolveWaitUntilTask<T>(task: WaitUntilTask<T>): Promise<T> {
  if (typeof task === "function") {
    return Promise.resolve().then(task);
  }
  return task;
}

export function wrapWaitUntilWithEvlog<T>(task: WaitUntilTask<T>): Promise<T> {
  const parent = getStore();
  if (!parent) return resolveWaitUntilTask(task);

  const parentContext = log.getContext();
  const parentRequest = parent.request;
  const waitUntilStartedAt = Date.now();

  const waitUntilPath = `${parentRequest.path}#waitUntil`;
  const waitUntilRequestId = `${parentRequest.requestId}:waitUntil:${crypto.randomUUID()}`;

  const waitUntilLogger = createRequestLogger<RequestEvlogEvent>({
    method: parentRequest.method,
    path: waitUntilPath,
    requestId: waitUntilRequestId,
  });

  const parentUser = parentContext.user;
  waitUntilLogger.set({
    request: {
      id: waitUntilRequestId,
      method: parentRequest.method,
      path: waitUntilPath,
      status: 500,
      duration: 0,
      waitUntil: true,
      parentRequestId: parentRequest.requestId,
    },
    ...(isRecord(parentUser) ? { user: parentUser } : {}),
  });

  return withRequestEvlogContext(
    {
      logger: waitUntilLogger,
      request: {
        requestId: waitUntilRequestId,
        method: parentRequest.method,
        path: waitUntilPath,
      },
      env: parent.env,
      executionCtx: parent.executionCtx,
    },
    async () => {
      let ok = false;
      try {
        const result = await resolveWaitUntilTask(task);
        ok = true;
        return result;
      } catch (error) {
        recordRequestEvlogError(error, {
          request: {
            status: 500,
            waitUntil: true,
            parentRequestId: parentRequest.requestId,
          },
        });
        throw error;
      } finally {
        const status = ok ? 200 : 500;
        const duration = Date.now() - waitUntilStartedAt;
        log.set({
          request: {
            status,
            duration,
            waitUntil: true,
            parentRequestId: parentRequest.requestId,
          },
        });
        flushRequestEvlog();
      }
    },
  );
}
