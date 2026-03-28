import { AsyncLocalStorage } from "node:async_hooks";
import { mergeLogRecords } from "./request-log.ts";
import type { WideLog } from "./types.ts";
import * as formatters from "./formatters.ts";
import * as buffer from "./buffer.ts";

const helpers = { ...formatters, ...buffer };

type LogLevel = "debug" | "info" | "warn" | "error";
type ExitHandler = (
  log: WideLog,
  helpers: typeof import("./formatters.ts") & typeof import("./buffer.ts"),
) => void | Promise<void>;

type Store = {
  log: WideLog;
  exitHandlers: ExitHandler[];
};

const storage = new AsyncLocalStorage<Store>();

function cloneLog<T>(value: T): T {
  return structuredClone(value);
}

function getStore(why: string): Store {
  let store = storage.getStore();
  if (!store) {
    store = {
      log: {
        meta: { id: "", start: new Date().toISOString() },
        errors: [new Error(`Logging outside logger.run(...) is illegal (${why})`)],
      },
      exitHandlers: [],
    };
    logger.globalExitHandlers.forEach((handler) => handler(store!.log, helpers));
  }

  return store;
}

function formatMessage(level: LogLevel, message: string, startedAt: number): string {
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1).replace(/\.?0+$/, "");
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
  await Promise.allSettled(handlers.map(async (handler) => handler(log, helpers)));
}

export const logger = {
  run: async <T>(callback: (params: { store: Store }) => T | Promise<T>): Promise<T> => {
    const parent = storage.getStore();
    const store: Store = {
      log: {
        meta: {
          id: `log_${crypto.randomUUID().replaceAll("-", "")}`,
          start: new Date().toISOString(),
        },
        ...(parent && { parent: cloneLog(parent.log) }),
      },
      exitHandlers: [],
    };

    return storage.run(store, async () => {
      try {
        return await callback({ store });
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
            new Date(currentStore.log.meta.start).getTime(),
          ),
        );
        currentStore.log.messages = messages;
        throw error;
      } finally {
        const currentStore = getStore(`logger.run finally`);
        currentStore.log.meta.end = new Date().toISOString();
        currentStore.log.meta.durationMs = Math.max(
          Date.now() - new Date(currentStore.log.meta.start).getTime(),
          0,
        );
        await emitExitHandlers(cloneLog(currentStore.log), [
          ...logger.globalExitHandlers,
          ...currentStore.exitHandlers,
        ]);
      }
    });
  },

  get: (): WideLog => cloneLog(getStore(`logger.get`).log),

  peek: (): WideLog | undefined => {
    const store = storage.getStore();
    return store ? cloneLog(store.log) : undefined;
  },

  set: (patch: Record<string, unknown>): void => {
    const store = getStore(`logger.set`);
    store.log = mergeLogRecords(store.log, patch) as WideLog;
  },

  getStore,
  globalExitHandlers: [] as ExitHandler[],

  info: (...args: unknown[]): void => {
    const store = getStore(`logger.info(${args.join(", ")})`);
    const { message, patch } = parseArgs(args);
    store.log = mergeLogRecords(store.log, patch) as WideLog;
    store.log.messages = [
      ...(store.log.messages ?? []),
      formatMessage("info", message, new Date(store.log.meta.start).getTime()),
    ];
  },

  debug: (...args: unknown[]): void => {
    const store = getStore(`logger.debug(${args.join(", ")})`);
    const { message, patch } = parseArgs(args);
    store.log = mergeLogRecords(store.log, patch) as WideLog;
    store.log.messages = [
      ...(store.log.messages ?? []),
      formatMessage("debug", message, new Date(store.log.meta.start).getTime()),
    ];
  },

  warn: (...args: unknown[]): void => {
    const store = getStore(`logger.warn(${args.join(", ")})`);
    const { message, patch } = parseArgs(args);
    store.log = mergeLogRecords(store.log, patch) as WideLog;
    store.log.messages = [
      ...(store.log.messages ?? []),
      formatMessage("warn", message, new Date(store.log.meta.start).getTime()),
    ];
  },

  error: (...args: unknown[]): void => {
    const store = getStore(`logger.error(${args.join(", ")})`);
    const { message, patch, error } = parseArgs(args);
    store.log = mergeLogRecords(store.log, patch) as WideLog;
    store.log.errors = [...(store.log.errors ?? []), toParsedError(error ?? message, message)];
    store.log.messages = [
      ...(store.log.messages ?? []),
      formatMessage("error", message, new Date(store.log.meta.start).getTime()),
    ];
  },
};
