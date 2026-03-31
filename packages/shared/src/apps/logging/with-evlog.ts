import { AsyncLocalStorage } from "node:async_hooks";
import { initLogger, type WideEvent } from "evlog";
import {
  createRequestLogger,
  resolveRequestId,
  type SharedRequestLogger,
} from "../../request-logging.ts";
import type { AppManifest } from "../types.ts";
import { formatEvlogRequestSummaryMessage } from "./runtime.ts";
import {
  installEvlogConsoleFilter,
  renderPrettyStdoutEvent,
  writePrettyStdout,
  writeRawStdoutEvent,
} from "./stdout.ts";
import {
  AppLogsConfig,
  AppRequestLogFilterRule,
  type AppRequestLogFilteringConfig,
} from "./types.ts";

export {
  createPrettyStdoutDrain,
  createRawStdoutDrain,
  formatCompactDuration,
  installEvlogConsoleFilter,
  renderPrettyStdoutEvent,
  writePrettyStdout,
  writeRawStdoutEvent,
} from "./stdout.ts";
export type { AppStdoutEvent, RequestLogEntry } from "./stdout.ts";

const defaultRequestLogFilterRules = [
  AppRequestLogFilterRule.parse({
    path: "/posthog-proxy/**",
    statuses: [200, 204, 304],
    action: "drop",
  }),
] satisfies AppRequestLogFilterRule[];

function matchesPathPattern(path: string, pattern: string) {
  const escaped = pattern.replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&");
  const regexSource = escaped.replaceAll("\\*\\*", ".*").replaceAll("\\*", "[^/]*");
  return new RegExp(`^${regexSource}$`).test(path);
}

function matchesRequestLogFilterRule(options: {
  path: string;
  status: number;
  rule: AppRequestLogFilterRule;
}) {
  const { path, status, rule } = options;

  if (rule.path && !matchesPathPattern(path, rule.path)) {
    return false;
  }

  if (rule.statuses && !rule.statuses.includes(status)) {
    return false;
  }

  if (typeof rule.minStatus === "number" && status < rule.minStatus) {
    return false;
  }

  return true;
}

/**
 * Shared app-runtime request-log filter policy.
 *
 * Errors always keep. App-config rules win over defaults, then shared defaults
 * apply, and finally unmatched requests are kept.
 */
export function shouldKeepAppRequestLog(options: {
  path: string;
  status: number;
  hasError: boolean;
  filtering?: AppRequestLogFilteringConfig;
}) {
  if (options.hasError) {
    return true;
  }

  const rules = [...(options.filtering?.rules ?? []), ...defaultRequestLogFilterRules];
  for (const rule of rules) {
    if (!matchesRequestLogFilterRule({ path: options.path, status: options.status, rule })) {
      continue;
    }

    return rule.action === "keep";
  }

  return true;
}

type EvlogExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

type WithEvlogState = {
  request: {
    requestId: string;
    method: string;
    path: string;
  };
  config: {
    logs: AppLogsConfig;
  };
  executionCtx?: EvlogExecutionContext;
  flushed: boolean;
};

type EvlogFlushHandler = (payload: {
  event: WideEvent;
  executionCtx?: EvlogExecutionContext;
}) => void | Promise<void>;

const logStorage = new AsyncLocalStorage<SharedRequestLogger>();
const stateStorage = new AsyncLocalStorage<WithEvlogState>();

let flushHandler: EvlogFlushHandler | undefined;

function getCurrentLogger() {
  const log = logStorage.getStore();
  if (!log) {
    throw new Error("No evlog request logger is active in the current async scope.");
  }

  return log;
}

export const currentEvlog: SharedRequestLogger = {
  set: (...args) => getCurrentLogger().set(...args),
  error: (...args) => getCurrentLogger().error(...args),
  info: (...args) => getCurrentLogger().info(...args),
  warn: (...args) => getCurrentLogger().warn(...args),
  emit: (...args) => getCurrentLogger().emit(...args),
  getContext: () => getCurrentLogger().getContext(),
};

export function getCurrentEvlog() {
  return logStorage.getStore();
}

export function setWithEvlogFlushHandler(handler?: EvlogFlushHandler) {
  flushHandler = handler;
}

export async function withEvlog<TResponse extends Response>(
  options: {
    request: Request;
    manifest: AppManifest;
    config: { logs: AppLogsConfig };
    executionCtx?: EvlogExecutionContext;
  },
  run: (args: { log: SharedRequestLogger }) => Promise<TResponse>,
): Promise<TResponse> {
  configureEvlogRuntime();

  const requestId = resolveRequestId(options.request);
  const requestPath = new URL(options.request.url).pathname;
  const log = createRequestLogger({
    method: options.request.method,
    path: requestPath,
    requestId,
  });

  log.set({
    appName: options.manifest.packageName,
    app: {
      slug: options.manifest.slug,
      packageName: options.manifest.packageName,
    },
    config: options.config,
    ...createRequestContextFields(options.request),
  });

  const state: WithEvlogState = {
    request: {
      requestId,
      method: options.request.method,
      path: requestPath,
    },
    config: options.config,
    executionCtx: options.executionCtx,
    flushed: false,
  };

  const startedAt = Date.now();

  return stateStorage.run(state, () =>
    logStorage.run(log, async () => {
      try {
        const response = await run({ log });
        flushCurrentEvlog({
          status: response.status,
          durationMs: Date.now() - startedAt,
        });
        return response;
      } catch (error) {
        log.error(error instanceof Error ? error : new Error(String(error)));
        flushCurrentEvlog({
          status: extractErrorStatus(error),
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    }),
  );
}

function configureEvlogRuntime() {
  installEvlogConsoleFilter();
  initLogger({
    env: {},
    pretty: false,
    stringify: false,
  });
}

function createRequestContextFields(request: Request) {
  const cf = Reflect.get(request, "cf");
  const workerContext =
    typeof cf === "object" && cf !== null
      ? {
          colo: typeof Reflect.get(cf, "colo") === "string" ? Reflect.get(cf, "colo") : undefined,
          country:
            typeof Reflect.get(cf, "country") === "string" ? Reflect.get(cf, "country") : undefined,
          asn: typeof Reflect.get(cf, "asn") === "number" ? Reflect.get(cf, "asn") : undefined,
        }
      : {};

  return {
    cfRay: request.headers.get("cf-ray") ?? undefined,
    traceparent: request.headers.get("traceparent") ?? undefined,
    ...workerContext,
  };
}

function flushCurrentEvlog(options: { status: number; durationMs: number }) {
  const state = stateStorage.getStore();
  const log = logStorage.getStore();
  if (!state || !log || state.flushed) {
    return undefined;
  }

  state.flushed = true;

  const logContext = log.getContext();
  const hasError = Boolean(logContext.error);
  if (
    !shouldKeepAppRequestLog({
      path: state.request.path,
      status: options.status,
      hasError,
      filtering: state.config.logs.filtering,
    })
  ) {
    return undefined;
  }

  const requestLogCount = Array.isArray(logContext.requestLogs) ? logContext.requestLogs.length : 0;

  const event = log.emit({
    status: options.status,
    durationMs: options.durationMs,
    message: formatEvlogRequestSummaryMessage({
      method: state.request.method,
      path: state.request.path,
      status: options.status,
      durationMs: options.durationMs,
      requestLogCount,
    }),
  });

  if (!event) {
    return undefined;
  }

  if (state.config.logs.stdoutFormat === "pretty") {
    writePrettyStdout(renderPrettyStdoutEvent(event));
  } else {
    writeRawStdoutEvent(event);
  }

  if (!flushHandler) {
    return event;
  }

  const task = Promise.resolve(
    flushHandler({
      event,
      executionCtx: state.executionCtx,
    }),
  ).catch((error) => {
    console.error("[withEvlog] flush handler failed", error);
  });

  if (state.executionCtx) {
    state.executionCtx.waitUntil(task);
  } else {
    void task;
  }

  return event;
}

function extractErrorStatus(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return 500;
  }

  const status = Reflect.get(error, "status");
  if (typeof status === "number") {
    return status;
  }

  const statusCode = Reflect.get(error, "statusCode");
  if (typeof statusCode === "number") {
    return statusCode;
  }

  return 500;
}
