import { AsyncLocalStorage } from "node:async_hooks";
import { mergeLogRecords } from "./request-log.ts";
import type { WideLog } from "./types.ts";
import * as formatters from "./formatters.ts";

type LogLevel = "debug" | "info" | "warn" | "error";
type ExitHandler = (
  log: WideLog,
  helpers: typeof import("./formatters.ts"),
) => void | Promise<void>;

type Store = {
  log: WideLog;
  startedAt: number;
  exitHandlers: ExitHandler[];
};

const storage = new AsyncLocalStorage<Store>();
const globalExitHandlers = new Set<ExitHandler>();

function cloneLog<T>(value: T): T {
  return structuredClone(value);
}

function getStore(why: string): Store {
  let store = storage.getStore();
  if (!store) {
    // console.log("getStore", { why, globalExitHandlers });
    store = {
      startedAt: Date.now(),
      log: { meta: { id: "", start: new Date().toISOString() }, errors: [] },
      exitHandlers: [],
    };
    store.log.errors!.push(new Error(`Logging outside logger.run(...) is illegal (${why})`));
    globalExitHandlers.forEach((handler) => handler(store!.log, formatters));
  }

  return store;
}

function formatMessage(level: LogLevel, message: string, startedAt: number): string {
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  return `[${level.toUpperCase()}] ${elapsedSeconds}s: ${message}`;
}

function toParsedError(error: unknown, fallbackMessage?: string): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...("cause" in error ? { cause: (error as Error & { cause?: unknown }).cause } : {}),
    };
  }

  return {
    name: "NonErrorThrowable",
    message: fallbackMessage ?? String(error),
    stack: new Error(fallbackMessage ?? String(error)).stack,
  };
}

function parseArgs(args: unknown[]): {
  message: string;
  patch: Record<string, unknown>;
  error?: unknown;
} {
  const patch: Record<string, unknown> = {};
  const messageParts: string[] = [];
  let error: unknown;

  for (const arg of args) {
    if (arg instanceof Error) {
      error ??= arg;
      continue;
    }

    if (typeof arg === "object" && arg !== null && !Array.isArray(arg)) {
      Object.assign(patch, arg);
      continue;
    }

    messageParts.push(typeof arg === "string" ? arg : String(arg));
  }

  const message =
    messageParts.length > 0
      ? messageParts.join(" ")
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : "log";

  return { message, patch, error };
}

async function emitExitHandlers(log: WideLog, handlers: ExitHandler[]): Promise<void> {
  await Promise.allSettled(handlers.map(async (handler) => handler(log, formatters)));
}

export const logger = {
  run: async <T>(callback: () => T | Promise<T>): Promise<T> => {
    const parent = storage.getStore();
    const store: Store = {
      log: {
        meta: {
          id: `log_${crypto.randomUUID().replaceAll("-", "")}`,
          start: new Date().toISOString(),
        },
        ...(parent && { parent: { meta: parent.log.meta } }),
      },
      startedAt: Date.now(),
      exitHandlers: [],
    };

    return storage.run(store, async () => {
      try {
        return await callback();
      } catch (error) {
        const currentStore = getStore(`logger.run catch ${error}`);
        const errors = Array.isArray(currentStore.log.errors) ? [...currentStore.log.errors] : [];
        errors.push(toParsedError(error));
        currentStore.log.errors = errors;
        const messages = Array.isArray(currentStore.log.messages)
          ? [...currentStore.log.messages]
          : [];
        messages.push(
          formatMessage(
            "error",
            error instanceof Error ? error.message : String(error),
            currentStore.startedAt,
          ),
        );
        currentStore.log.messages = messages;
        throw error;
      } finally {
        const currentStore = getStore(`logger.run finally`);
        currentStore.log.meta.end = new Date().toISOString();
        currentStore.log.meta.durationMs = Math.max(Date.now() - currentStore.startedAt, 0);
        // console.log(
        //   "logger.run finally",
        //   currentStore.log,
        //   globalExitHandlers,
        //   currentStore.exitHandlers,
        // );
        await emitExitHandlers(cloneLog(currentStore.log), [
          ...globalExitHandlers,
          ...currentStore.exitHandlers,
        ]);
      }
    });
  },

  get: (): WideLog => cloneLog(getStore(`logger.get`).log),

  set: (patch: Record<string, unknown>): void => {
    const store = getStore(`logger.set`);
    store.log = mergeLogRecords(store.log, patch) as WideLog;
  },

  onExit: (handler: ExitHandler): (() => void) => {
    const store = storage.getStore();
    if (store) {
      store.exitHandlers.push(handler);
      return () => {
        store.exitHandlers = store.exitHandlers.filter((candidate) => candidate !== handler);
      };
    }

    globalExitHandlers.add(handler);
    return () => {
      globalExitHandlers.delete(handler);
    };
  },

  info: (...args: unknown[]): void => {
    const store = getStore(`logger.info(${args.join(", ")})`);
    const { message, patch } = parseArgs(args);
    store.log = mergeLogRecords(store.log, patch) as WideLog;
    store.log.messages = [
      ...(store.log.messages ?? []),
      formatMessage("info", message, store.startedAt),
    ];
  },

  debug: (...args: unknown[]): void => {
    const store = getStore(`logger.debug(${args.join(", ")})`);
    const { message, patch } = parseArgs(args);
    store.log = mergeLogRecords(store.log, patch) as WideLog;
    store.log.messages = [
      ...(store.log.messages ?? []),
      formatMessage("debug", message, store.startedAt),
    ];
  },

  warn: (...args: unknown[]): void => {
    const store = getStore(`logger.warn(${args.join(", ")})`);
    const { message, patch } = parseArgs(args);
    store.log = mergeLogRecords(store.log, patch) as WideLog;
    store.log.messages = [
      ...(store.log.messages ?? []),
      formatMessage("warn", message, store.startedAt),
    ];
  },

  error: (...args: unknown[]): void => {
    const store = getStore(`logger.error(${args.join(", ")})`);
    const { message, patch, error } = parseArgs(args);
    store.log = mergeLogRecords(store.log, patch) as WideLog;
    store.log.errors = [...(store.log.errors ?? []), toParsedError(error ?? message, message)];
    store.log.messages = [
      ...(store.log.messages ?? []),
      formatMessage("error", message, store.startedAt),
    ];
  },
};
