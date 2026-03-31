import { RpcTarget } from "cloudflare:workers";
import { sanitizeToolName } from "~/lib/codemode/json-schema-types.ts";
import { normalizeCode } from "~/lib/codemode/normalize.ts";

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

export type ProviderMode = "value" | "stream";

export interface ResolvedProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  mode?: ProviderMode;
  positionalArgs?: boolean;
}

export interface DynamicWorkerExecutorOptions {
  loader: WorkerLoader;
  timeout?: number;
  globalOutbound?: Fetcher | null;
  modules?: Record<string, string>;
}

function stringifyRpcEnvelope(value: unknown) {
  return JSON.stringify({ result: value });
}

function stringifyRpcError(error: unknown) {
  return JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

class RemoteAsyncIteratorDispatcher extends RpcTarget {
  #iterator: AsyncIterator<unknown>;

  constructor(iterable: AsyncIterable<unknown>) {
    super();
    this.#iterator = iterable[Symbol.asyncIterator]();
  }

  async next() {
    try {
      return stringifyRpcEnvelope(await this.#iterator.next());
    } catch (error) {
      return stringifyRpcError(error);
    }
  }

  async return(valueJson?: string) {
    try {
      const value = valueJson ? JSON.parse(valueJson) : undefined;

      if (typeof this.#iterator.return === "function") {
        return stringifyRpcEnvelope(await this.#iterator.return(value));
      }

      return stringifyRpcEnvelope({ value, done: true });
    } catch (error) {
      return stringifyRpcError(error);
    }
  }

  async throw(errorJson?: string) {
    try {
      const errorValue = errorJson ? JSON.parse(errorJson) : undefined;

      if (typeof this.#iterator.throw === "function") {
        return stringifyRpcEnvelope(await this.#iterator.throw(errorValue));
      }

      throw errorValue;
    } catch (error) {
      return stringifyRpcError(error);
    }
  }
}

class ToolDispatcher extends RpcTarget {
  #fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  #mode: ProviderMode;
  #positionalArgs: boolean;

  constructor(
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
    options?: { mode?: ProviderMode; positionalArgs?: boolean },
  ) {
    super();
    this.#fns = fns;
    this.#mode = options?.mode ?? "value";
    this.#positionalArgs = options?.positionalArgs ?? false;
  }

  async call(name: string, argsJson: string) {
    const fn = this.#fns[name];
    if (!fn) return stringifyRpcError(`Tool "${name}" not found`);
    if (this.#mode !== "value") return stringifyRpcError(`Tool "${name}" is stream-only`);

    try {
      if (this.#positionalArgs) {
        const args = argsJson ? JSON.parse(argsJson) : [];
        const result = await fn(...(Array.isArray(args) ? args : [args]));
        return stringifyRpcEnvelope(result);
      }

      const result = await fn(argsJson ? JSON.parse(argsJson) : {});
      return stringifyRpcEnvelope(result);
    } catch (error) {
      return stringifyRpcError(error);
    }
  }

  async stream(name: string, argsJson: string) {
    const fn = this.#fns[name];
    if (!fn) {
      throw new Error(`Tool "${name}" not found`);
    }

    if (this.#mode !== "stream") {
      throw new Error(`Tool "${name}" is not a streaming tool`);
    }

    const parsedArgs = argsJson ? JSON.parse(argsJson) : this.#positionalArgs ? [] : {};
    const result = this.#positionalArgs
      ? await fn(...(Array.isArray(parsedArgs) ? parsedArgs : [parsedArgs]))
      : await fn(parsedArgs);

    if (!isAsyncIterable(result)) {
      throw new Error(`Tool "${name}" did not return an async iterable`);
    }

    return new RemoteAsyncIteratorDispatcher(result);
  }
}

export class DynamicWorkerExecutor {
  #loader: WorkerLoader;
  #timeout: number;
  #globalOutbound: Fetcher | null | undefined;
  #modules: Record<string, string>;

  constructor(options: DynamicWorkerExecutorOptions) {
    this.#loader = options.loader;
    this.#timeout = options.timeout ?? 30_000;
    this.#globalOutbound = options.globalOutbound ?? null;

    const { "executor.js": _executorModule, ...safeModules } = options.modules ?? {};
    this.#modules = safeModules;
  }

  async execute(code: string, providers: ResolvedProvider[]): Promise<ExecuteResult> {
    const normalized = normalizeCode(code);
    const timeoutMs = this.#timeout;
    const reservedNames = new Set(["__dispatchers", "__logs"]);
    const validIdentifier = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
    const seenNames = new Set<string>();

    for (const provider of providers) {
      if (reservedNames.has(provider.name)) {
        return { result: undefined, error: `Provider name "${provider.name}" is reserved` };
      }

      if (!validIdentifier.test(provider.name)) {
        return {
          result: undefined,
          error: `Provider name "${provider.name}" is not a valid JavaScript identifier`,
        };
      }

      if (seenNames.has(provider.name)) {
        return { result: undefined, error: `Duplicate provider name "${provider.name}"` };
      }

      seenNames.add(provider.name);
    }

    const executorModule = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "",
      "function __createRemoteAsyncIterator(target) {",
      "  return {",
      "    [Symbol.asyncIterator]() {",
      "      return this;",
      "    },",
      "    async next() {",
      "      const resJson = await target.next();",
      "      const data = JSON.parse(resJson);",
      "      if (data.error) throw new Error(data.error);",
      "      return data.result;",
      "    },",
      "    async return(value) {",
      "      const resJson = await target.return(JSON.stringify(value ?? null));",
      "      const data = JSON.parse(resJson);",
      "      if (data.error) throw new Error(data.error);",
      "      return data.result ?? { value, done: true };",
      "    },",
      "    async throw(error) {",
      "      const resJson = await target.throw(JSON.stringify({ message: String(error) }));",
      "      const data = JSON.parse(resJson);",
      "      if (data.error) throw new Error(data.error);",
      "      return data.result;",
      "    },",
      "  };",
      "}",
      "",
      "function __stringifyLogValue(value) {",
      "  if (typeof value === 'string') return value;",
      "  if (typeof value === 'undefined') return 'undefined';",
      "  try {",
      "    return JSON.stringify(value, null, 2);",
      "  } catch {",
      "    return String(value);",
      "  }",
      "}",
      "",
      "export default class CodeExecutor extends WorkerEntrypoint {",
      "  async evaluate(__dispatchers = {}) {",
      "    const __logs = [];",
      '    console.log = (...a) => { __logs.push(a.map(__stringifyLogValue).join(" ")); };',
      '    console.warn = (...a) => { __logs.push("[warn] " + a.map(__stringifyLogValue).join(" ")); };',
      '    console.error = (...a) => { __logs.push("[error] " + a.map(__stringifyLogValue).join(" ")); };',
      ...providers.map((provider) => {
        if (provider.mode === "stream") {
          return `    const ${provider.name} = new Proxy({}, {\n      get: (_, toolName) => async (args) => {\n        const target = await __dispatchers.${provider.name}.stream(String(toolName), JSON.stringify(args ?? {}));\n        return __createRemoteAsyncIterator(target);\n      }\n    });`;
        }

        if (provider.positionalArgs) {
          return `    const ${provider.name} = new Proxy({}, {\n      get: (_, toolName) => async (...args) => {\n        const resJson = await __dispatchers.${provider.name}.call(String(toolName), JSON.stringify(args));\n        const data = JSON.parse(resJson);\n        if (data.error) throw new Error(data.error);\n        return data.result;\n      }\n    });`;
        }

        return `    const ${provider.name} = new Proxy({}, {\n      get: (_, toolName) => async (args) => {\n        const resJson = await __dispatchers.${provider.name}.call(String(toolName), JSON.stringify(args ?? {}));\n        const data = JSON.parse(resJson);\n        if (data.error) throw new Error(data.error);\n        return data.result;\n      }\n    });`;
      }),
      "",
      "    try {",
      "      const result = await Promise.race([",
      "        (",
      normalized,
      "        )(),",
      `        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${timeoutMs}))`,
      "      ]);",
      "      return { result, logs: __logs };",
      "    } catch (error) {",
      "      return {",
      "        result: undefined,",
      "        error: error instanceof Error ? error.message : String(error),",
      "        logs: __logs,",
      "      };",
      "    }",
      "  }",
      "}",
    ].join("\n");

    const dispatchers: Record<string, ToolDispatcher> = {};

    for (const provider of providers) {
      const sanitizedFns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

      for (const [name, fn] of Object.entries(provider.fns)) {
        sanitizedFns[sanitizeToolName(name)] = fn;
      }

      dispatchers[provider.name] = new ToolDispatcher(sanitizedFns, {
        mode: provider.mode,
        positionalArgs: provider.positionalArgs,
      });
    }

    const entrypoint = this.#loader
      .get(`codemode-${crypto.randomUUID()}`, () => ({
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        mainModule: "executor.js",
        modules: {
          ...this.#modules,
          "executor.js": executorModule,
        },
        globalOutbound: this.#globalOutbound,
      }))
      .getEntrypoint() as unknown as {
      evaluate(input: Record<string, ToolDispatcher>): Promise<ExecuteResult>;
    };
    const response = await entrypoint.evaluate(dispatchers);

    if (response.error) {
      return {
        result: undefined,
        error: response.error,
        logs: response.logs,
      };
    }

    return {
      result: response.result,
      logs: response.logs,
    };
  }
}
