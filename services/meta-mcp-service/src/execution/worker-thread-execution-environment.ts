import { Worker } from "node:worker_threads";
import { serializeError } from "../errors.ts";
import { logInfo, logWarn } from "../logger.ts";
import type { MetaMcpExecutionEnvironment, MetaMcpExecutionResult } from "./types.ts";

type WorkerRequest =
  | {
      type: "invoke";
      requestId: string;
      path: string[];
      args: unknown[];
    }
  | {
      type: "result";
      result: unknown;
      logs: string[];
    }
  | {
      type: "error";
      error: unknown;
      logs: string[];
    };

type WorkerResponse =
  | {
      type: "resolve";
      requestId: string;
      value: unknown;
    }
  | {
      type: "reject";
      requestId: string;
      error: unknown;
    };

function describeToolShape(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return null;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, describeToolShape(nested)]),
  );
}

function resolveToolCall(tools: Record<string, unknown>, path: string[]) {
  let current: unknown = tools;

  for (const segment of path) {
    if (!current || (typeof current !== "object" && typeof current !== "function")) {
      throw new Error(`Meta MCP tool path '${path.join(".")}' is invalid`);
    }

    current = Reflect.get(current, segment);
  }

  if (typeof current !== "function") {
    throw new Error(`Meta MCP tool path '${path.join(".")}' is not callable`);
  }

  return current as (...args: unknown[]) => Promise<unknown> | unknown;
}

function createWorkerSource() {
  return `
    const { parentPort, workerData } = require("node:worker_threads");
    const { inspect } = require("node:util");

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const pending = new Map();
    let requestCounter = 0;

    function formatValue(value) {
      return typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 120 });
    }

    function lookupShape(path) {
      let current = workerData.toolShape;
      for (const segment of path) {
        if (!current || typeof current !== "object") return null;
        current = current[segment];
      }
      return current && typeof current === "object" ? current : null;
    }

    function createToolProxy(path = []) {
      const callable = () => undefined;
      return new Proxy(callable, {
        get(_target, prop) {
          if (prop === "then" && path.length === 0) return undefined;
          if (typeof prop === "symbol") return undefined;
          return createToolProxy([...path, String(prop)]);
        },
        ownKeys() {
          const shape = lookupShape(path);
          return shape ? Object.keys(shape) : [];
        },
        getOwnPropertyDescriptor(_target, prop) {
          if (typeof prop === "symbol") return undefined;
          const shape = lookupShape(path);
          if (shape && Object.prototype.hasOwnProperty.call(shape, prop)) {
            return {
              configurable: true,
              enumerable: true,
              writable: false,
              value: createToolProxy([...path, String(prop)]),
            };
          }
          return undefined;
        },
        apply(_target, _thisArg, args) {
          const requestId = String(++requestCounter);
          parentPort.postMessage({
            type: "invoke",
            requestId,
            path,
            args,
          });

          return new Promise((resolve, reject) => {
            pending.set(requestId, { resolve, reject });
          });
        },
      });
    }

    parentPort.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type !== "resolve" && message.type !== "reject") return;

      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);

      if (message.type === "resolve") {
        entry.resolve(message.value);
        return;
      }

      const details = message.error && typeof message.error === "object" ? message.error : {};
      const error = new Error(
        typeof details.message === "string" ? details.message : String(message.error),
      );
      if (typeof details.name === "string") {
        error.name = details.name;
      }
      entry.reject(error);
    });

    (async () => {
      const logs = [];
      const appendLog = (prefix, args) => {
        if (logs.length >= workerData.maxLogs) return;
        const line = args.map(formatValue).join(" ");
        logs.push(prefix ? prefix + line : line);
      };

      const consoleLike = {
        log: (...args) => appendLog("", args),
        warn: (...args) => appendLog("[warn] ", args),
        error: (...args) => appendLog("[error] ", args),
      };

      try {
        const fn = new AsyncFunction(
          "tools",
          "console",
          "return await (async () => {\\n" + workerData.code + "\\n})();",
        );
        const result = await fn(createToolProxy(), consoleLike);
        parentPort.postMessage({ type: "result", result, logs });
      } catch (error) {
        parentPort.postMessage({
          type: "error",
          logs,
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
        });
      }
    })();
  `;
}

export class WorkerThreadMetaMcpExecutionEnvironment<
  TTools extends Record<string, unknown>,
> implements MetaMcpExecutionEnvironment<TTools> {
  readonly kind = "worker-thread";

  constructor(
    private readonly options: {
      timeoutMs?: number;
      maxLogs?: number;
    } = {},
  ) {}

  async execute(params: { code: string; tools: TTools }): Promise<MetaMcpExecutionResult> {
    const startedAt = Date.now();
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const maxLogs = this.options.maxLogs ?? 200;

    logInfo("starting worker-thread metamcp execution", {
      codeLength: params.code.length,
      helperKeys: Object.keys(params.tools),
      timeoutMs,
    });

    return await new Promise<MetaMcpExecutionResult>((resolve) => {
      const worker = new Worker(createWorkerSource(), {
        eval: true,
        workerData: {
          code: params.code,
          maxLogs,
          toolShape: describeToolShape(params.tools),
        },
      });

      let finished = false;

      const finish = async (result: MetaMcpExecutionResult) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timeout);
        worker.removeAllListeners();
        await worker.terminate().catch(() => undefined);
        resolve(result);
      };

      const timeout = setTimeout(() => {
        void finish({
          result: null,
          logs: [],
          error: serializeError(
            new Error(`Meta MCP execution timed out after ${String(timeoutMs)}ms`),
          ),
        });
      }, timeoutMs);

      worker.on("message", async (message: WorkerRequest) => {
        if (!message || typeof message !== "object") {
          return;
        }

        if (message.type === "invoke") {
          try {
            const tool = resolveToolCall(params.tools, message.path);
            const value = await tool(...message.args);
            worker.postMessage({
              type: "resolve",
              requestId: message.requestId,
              value,
            } satisfies WorkerResponse);
          } catch (error) {
            worker.postMessage({
              type: "reject",
              requestId: message.requestId,
              error: serializeError(error),
            } satisfies WorkerResponse);
          }
          return;
        }

        if (message.type === "result") {
          logInfo("worker-thread metamcp execution completed", {
            durationMs: Date.now() - startedAt,
            logCount: message.logs.length,
          });
          await finish({ result: message.result, logs: message.logs });
          return;
        }

        if (message.type === "error") {
          logWarn("worker-thread metamcp execution failed", {
            durationMs: Date.now() - startedAt,
            logCount: message.logs.length,
            error:
              typeof message.error === "object" &&
              message.error !== null &&
              "message" in message.error &&
              typeof message.error.message === "string"
                ? message.error.message
                : String(message.error),
          });
          await finish({
            result: null,
            logs: message.logs,
            error: serializeError(message.error),
          });
        }
      });

      worker.on("error", async (error: unknown) => {
        logWarn("worker-thread metamcp worker crashed", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        await finish({
          result: null,
          logs: [],
          error: serializeError(error),
        });
      });
    });
  }
}
