/**
 * Executor: runs LLM-generated code in an isolated Cloudflare Dynamic Worker.
 *
 * Adapted from @cloudflare/codemode (cloudflare/agents):
 * https://github.com/cloudflare/agents/blob/main/packages/codemode/src/executor.ts
 *
 * Key differences from upstream:
 * - Paths are string[] instead of dotted strings
 * - Event callbacks for log/tool-call streaming
 * - LogDispatcher RpcTarget for streaming logs back from sandbox
 */

import { RpcTarget } from "cloudflare:workers";
import { normalizeCode } from "./normalize.ts";
import { sanitizeToolName, sanitizeToolPath } from "./utils.ts";
import type { ToolProvider, CodemodeEvent } from "./types.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

export interface ResolvedProvider {
  path: string[];
  provider: ToolProvider;
}

export interface ExecutorOptions {
  loader: WorkerLoader;
  timeout?: number;
  globalOutbound?: Fetcher | null;
  modules?: Record<string, string>;
}

export interface ExecuteOptions {
  code: string;
  providers: ResolvedProvider[];
  blockId: string;
  onEvent: (event: CodemodeEvent) => void;
  signal?: AbortSignal;
}

// ── LogDispatcher ────────────────────────────────────────────────────

export class LogDispatcher extends RpcTarget {
  #onLog: (level: "log" | "warn" | "error", message: string) => void;

  constructor(onLog: (level: "log" | "warn" | "error", message: string) => void) {
    super();
    this.#onLog = onLog;
  }

  log(level: string, message: string) {
    const validLevel = level === "warn" || level === "error" ? level : "log";
    this.#onLog(validLevel, message);
  }
}

// ── ToolDispatcher ───────────────────────────────────────────────────

export class ToolDispatcher extends RpcTarget {
  #provider: ToolProvider;
  #onToolCall?: (callId: string, path: string[], payload: unknown) => void;
  #onToolResult?: (callId: string, result: unknown) => void;
  #onToolError?: (callId: string, error: string) => void;
  #nextCallId: () => string;

  constructor(options: {
    provider: ToolProvider;
    generateCallId: () => string;
    onToolCall?: (callId: string, path: string[], payload: unknown) => void;
    onToolResult?: (callId: string, result: unknown) => void;
    onToolError?: (callId: string, error: string) => void;
  }) {
    super();
    this.#provider = options.provider;
    this.#nextCallId = options.generateCallId;
    this.#onToolCall = options.onToolCall;
    this.#onToolResult = options.onToolResult;
    this.#onToolError = options.onToolError;
  }

  async call(pathJson: string, argsJson: string): Promise<string> {
    const callId = this.#nextCallId();
    try {
      const path: string[] = pathJson ? JSON.parse(pathJson) : [];
      const parsed = argsJson ? JSON.parse(argsJson) : [];
      const payload = Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed;

      this.#onToolCall?.(callId, path, payload);

      const result = await this.#provider.execute(path, payload);

      this.#onToolResult?.(callId, result);
      return JSON.stringify({ result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#onToolError?.(callId, message);
      return JSON.stringify({ error: message });
    }
  }
}

// ── Executor ─────────────────────────────────────────────────────────

const RESERVED_SEGMENTS = new Set(["__dispatchers", "__logs", "__logger"]);

export class CodemodeExecutor {
  #loader: WorkerLoader;
  #timeout: number;
  #globalOutbound: Fetcher | null;
  #modules: Record<string, string>;

  constructor(options: ExecutorOptions) {
    this.#loader = options.loader;
    this.#timeout = options.timeout ?? 30_000;
    this.#globalOutbound = options.globalOutbound ?? null;
    const { "executor.js": _, ...safeModules } = options.modules ?? {};
    this.#modules = safeModules;
  }

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const { code, providers, blockId, onEvent, signal } = options;
    const normalized = normalizeCode(code);
    const timeoutMs = this.#timeout;

    // Validate provider paths
    const providerKeys = new Map<string, string[]>();
    const seenKeys = new Set<string>();

    for (const { path } of providers) {
      const safePath = path.map((s) => sanitizeToolName(s));
      const key = safePath.join(".");

      for (const segment of safePath) {
        if (RESERVED_SEGMENTS.has(segment)) {
          return { result: undefined, error: `Provider path segment "${segment}" is reserved` };
        }
      }

      if (seenKeys.has(key)) {
        return { result: undefined, error: `Duplicate provider path: ${key}` };
      }

      for (const existing of seenKeys) {
        if (key.startsWith(existing + ".") || existing.startsWith(key + ".")) {
          return {
            result: undefined,
            error: `Provider path "${key}" conflicts with "${existing}"`,
          };
        }
      }

      seenKeys.add(key);
      providerKeys.set(key, safePath);
    }

    // Build proxy initializers for each provider namespace
    const proxyInits = providers.map(({ path }) => {
      const safePath = path.map((s) => sanitizeToolName(s));
      const providerKey = safePath.join(".");
      const root = safePath[0]!;
      const setupLines = [
        `    globalThis.${root} ??= {};`,
        ...safePath.slice(1, -1).map((_, i) => {
          const child = safePath.slice(0, i + 2).join(".");
          return `    ${child} ??= {};`;
        }),
      ];
      const assignTarget = providerKey;
      return [
        ...setupLines,
        `    ${assignTarget} = (() => {`,
        `      const make = (path = []) => new Proxy(async () => {}, {`,
        `        get: (_, key) => typeof key === "string" ? make([...path, key]) : undefined,`,
        `        apply: async (_, __, args) => {`,
        `          const resJson = await __dispatchers[${JSON.stringify(providerKey)}].call(JSON.stringify(path), JSON.stringify(args));`,
        `          const data = JSON.parse(resJson);`,
        `          if (data.error) throw new Error(data.error);`,
        `          return data.result;`,
        `        }`,
        `      });`,
        `      return make();`,
        `    })();`,
      ].join("\n");
    });

    // Build executor module source
    const executorModule = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "",
      "function __stringify(v) {",
      "  if (typeof v === 'string') return v;",
      "  if (typeof v === 'undefined') return 'undefined';",
      "  try { return JSON.stringify(v, null, 2); } catch { return String(v); }",
      "}",
      "",
      "export default class CodeExecutor extends WorkerEntrypoint {",
      "  async evaluate(__dispatchers = {}, __logger = null) {",
      "    const __logs = [];",
      "    console.log = (...a) => {",
      "      const msg = a.map(__stringify).join(' ');",
      "      __logs.push(msg);",
      "      if (__logger) __logger.log('log', msg);",
      "    };",
      "    console.warn = (...a) => {",
      "      const msg = '[warn] ' + a.map(__stringify).join(' ');",
      "      __logs.push(msg);",
      "      if (__logger) __logger.log('warn', a.map(__stringify).join(' '));",
      "    };",
      "    console.error = (...a) => {",
      "      const msg = '[error] ' + a.map(__stringify).join(' ');",
      "      __logs.push(msg);",
      "      if (__logger) __logger.log('error', a.map(__stringify).join(' '));",
      "    };",
      ...proxyInits,
      "",
      "    try {",
      "      const result = await Promise.race([",
      "        (",
    ]
      .concat([normalized])
      .concat([
        ")(),",
        `        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${timeoutMs}))`,
        "      ]);",
        "      return { result, logs: __logs };",
        "    } catch (err) {",
        "      return { result: undefined, error: err.message, logs: __logs };",
        "    }",
        "  }",
        "}",
      ])
      .join("\n");

    // Build dispatchers
    let callIdCounter = 0;
    const generateCallId = () => `ccal_${blockId}_${++callIdCounter}`;

    const dispatchers: Record<string, ToolDispatcher> = {};
    for (const { path, provider } of providers) {
      const safePath = path.map((s) => sanitizeToolName(s));
      const providerKey = safePath.join(".");
      dispatchers[providerKey] = new ToolDispatcher({
        provider,
        generateCallId,
        onToolCall: (callId, toolPath, payload) => {
          onEvent({
            type: "codemode-tool-call-requested",
            blockId,
            timestamp: new Date().toISOString(),
            callId,
            path: toolPath,
            payload,
          });
        },
        onToolResult: (callId, result) => {
          onEvent({
            type: "codemode-tool-call-succeeded",
            blockId,
            timestamp: new Date().toISOString(),
            callId,
            result,
          });
        },
        onToolError: (callId, error) => {
          onEvent({
            type: "codemode-tool-call-failed",
            blockId,
            timestamp: new Date().toISOString(),
            callId,
            error,
          });
        },
      });
    }

    // Build log dispatcher
    const logDispatcher = new LogDispatcher((level, message) => {
      onEvent({
        type: "codemode-log-emitted",
        blockId,
        timestamp: new Date().toISOString(),
        level,
        message,
      });
    });

    // Spin up dynamic worker and execute
    const worker = this.#loader.get(`codemode-${crypto.randomUUID()}`, () => ({
      compatibilityDate: "2025-06-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "executor.js",
      modules: {
        ...this.#modules,
        "executor.js": executorModule,
      },
      globalOutbound: this.#globalOutbound,
    }));

    const entrypoint = worker.getEntrypoint() as unknown as {
      evaluate(
        dispatchers: Record<string, ToolDispatcher>,
        logger: LogDispatcher | null,
      ): Promise<{
        result: unknown;
        error?: string;
        logs?: string[];
      }>;
    };

    if (signal?.aborted) {
      return { result: undefined, error: "Aborted" };
    }

    const response = await entrypoint.evaluate(dispatchers, logDispatcher);

    if (response.error) {
      return { result: undefined, error: response.error, logs: response.logs };
    }

    return { result: response.result, logs: response.logs };
  }
}
