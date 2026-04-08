import { RpcTarget } from "cloudflare:workers";
import { normalizeCode, sanitizeToolName } from "@cloudflare/codemode";
import type { Modules } from "@cloudflare/worker-bundler";

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
  modules?: Modules;
}

export interface WorkerBundleDefinition {
  mainModule: string;
  modules: Modules;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
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

function createImportPath(fromModule: string, toModule: string) {
  const fromParts = fromModule.split("/");
  fromParts.pop();
  const toParts = toModule.split("/");
  let sharedIndex = 0;

  while (sharedIndex < fromParts.length && sharedIndex < toParts.length) {
    if (fromParts[sharedIndex] !== toParts[sharedIndex]) {
      break;
    }

    sharedIndex += 1;
  }

  const parentSegments = fromParts.slice(sharedIndex).map(() => "..");
  const childSegments = toParts.slice(sharedIndex);
  const relativePath = [...parentSegments, ...childSegments].join("/");

  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function createInlineUserModuleSource(code: string) {
  return `export default ${normalizeCode(code)};`;
}

function indent(value: string, spaces: number) {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function createExecutorModule(options: {
  providers: ResolvedProvider[];
  sandboxPrelude?: string;
  timeoutMs: number;
  userModulePath: string;
  getSecretProviderName?: string;
}) {
  const importPath = createImportPath("executor.js", options.userModulePath);
  const getSecretProviderName = options.getSecretProviderName ?? null;
  const sandboxPrelude = options.sandboxPrelude?.trim().length
    ? indent(options.sandboxPrelude.trim(), 4)
    : "    const ctx = { fetch: (...args) => fetch(...args) };";

  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    `import userDefault, * as userModule from "${importPath}";`,
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
    "function __resolveUserFn() {",
    "  if (typeof userDefault === 'function') return userDefault;",
    "  if (typeof userModule.run === 'function') return userModule.run;",
    "  throw new Error(",
    '    "Codemode entrypoint must export a default function or a named run() function.",',
    "  );",
    "}",
    "",
    "export default class CodeExecutor extends WorkerEntrypoint {",
    "  async evaluate(__dispatchers = {}) {",
    "    const __logs = [];",
    '    console.log = (...a) => { __logs.push(a.map(__stringifyLogValue).join(" ")); };',
    '    console.warn = (...a) => { __logs.push("[warn] " + a.map(__stringifyLogValue).join(" ")); };',
    '    console.error = (...a) => { __logs.push("[error] " + a.map(__stringifyLogValue).join(" ")); };',
    ...options.providers.map((provider) => {
      if (provider.mode === "stream") {
        return `    const ${provider.name} = new Proxy({}, {\n      get: (_, toolName) => async (args) => {\n        const target = await __dispatchers.${provider.name}.stream(String(toolName), JSON.stringify(args ?? {}));\n        return __createRemoteAsyncIterator(target);\n      }\n    });`;
      }

      if (provider.positionalArgs) {
        return `    const ${provider.name} = new Proxy({}, {\n      get: (_, toolName) => async (...args) => {\n        const resJson = await __dispatchers.${provider.name}.call(String(toolName), JSON.stringify(args));\n        const data = JSON.parse(resJson);\n        if (data.error) throw new Error(data.error);\n        return data.result;\n      }\n    });`;
      }

      return `    const ${provider.name} = new Proxy({}, {\n      get: (_, toolName) => async (args) => {\n        const resJson = await __dispatchers.${provider.name}.call(String(toolName), JSON.stringify(args ?? {}));\n        const data = JSON.parse(resJson);\n        if (data.error) throw new Error(data.error);\n        return data.result;\n      }\n    });`;
    }),
    sandboxPrelude,
    getSecretProviderName == null
      ? ""
      : `    const getIterateSecret = async (args) => ${getSecretProviderName}.getIterateSecret(args ?? {});`,
    "",
    "    try {",
    "      const __userFn = __resolveUserFn();",
    "      const result = await Promise.race([",
    getSecretProviderName == null
      ? "        __userFn({ ctx }),"
      : "        __userFn({ ctx, getIterateSecret }),",
    `        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${options.timeoutMs})),`,
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
  #modules: Modules;

  constructor(options: DynamicWorkerExecutorOptions) {
    this.#loader = options.loader;
    this.#timeout = options.timeout ?? 30_000;
    this.#globalOutbound = options.globalOutbound ?? null;
    this.#modules = options.modules ?? {};
  }

  async execute(code: string, providers: ResolvedProvider[]): Promise<ExecuteResult> {
    return this.executeWorkerBundle(
      {
        mainModule: "executor.js",
        modules: {
          "executor.js": createExecutorModule({
            providers,
            timeoutMs: this.#timeout,
            userModulePath: "user-inline.js",
          }),
          "user-inline.js": createInlineUserModuleSource(code),
        },
      },
      providers,
    );
  }

  async executeWorkerBundle(
    bundle: WorkerBundleDefinition,
    providers: ResolvedProvider[],
  ): Promise<ExecuteResult> {
    const validationError = validateProviderNames(providers);
    if (validationError) {
      return { result: undefined, error: validationError };
    }

    const entrypoint = this.#loader
      .get(`codemode-${crypto.randomUUID()}`, () => ({
        compatibilityDate: bundle.compatibilityDate ?? "2025-06-01",
        compatibilityFlags: bundle.compatibilityFlags ?? [
          "nodejs_compat",
          "global_fetch_strictly_public",
        ],
        mainModule: bundle.mainModule,
        modules: {
          ...this.#modules,
          ...bundle.modules,
        },
        globalOutbound: this.#globalOutbound,
      }))
      .getEntrypoint() as unknown as {
      evaluate(input: Record<string, ToolDispatcher>): Promise<ExecuteResult>;
    };

    const response = await entrypoint.evaluate(buildDispatchers(providers));

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

export function buildCodemodeExecutionBundle(options: {
  userModulePath: string;
  userModules: Modules;
  providers: ResolvedProvider[];
  sandboxPrelude?: string;
  timeoutMs?: number;
  getSecretProviderName?: string;
}): WorkerBundleDefinition {
  return {
    mainModule: "executor.js",
    modules: {
      ...options.userModules,
      "executor.js": createExecutorModule({
        providers: options.providers,
        sandboxPrelude: options.sandboxPrelude,
        timeoutMs: options.timeoutMs ?? 30_000,
        userModulePath: options.userModulePath,
        getSecretProviderName: options.getSecretProviderName,
      }),
    },
  };
}

function validateProviderNames(providers: ResolvedProvider[]) {
  const reservedNames = new Set(["__dispatchers", "__logs"]);
  const validIdentifier = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
  const seenNames = new Set<string>();

  for (const provider of providers) {
    if (reservedNames.has(provider.name)) {
      return `Provider name "${provider.name}" is reserved`;
    }

    if (!validIdentifier.test(provider.name)) {
      return `Provider name "${provider.name}" is not a valid JavaScript identifier`;
    }

    if (seenNames.has(provider.name)) {
      return `Duplicate provider name "${provider.name}"`;
    }

    seenNames.add(provider.name);
  }

  return null;
}

function buildDispatchers(providers: ResolvedProvider[]) {
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

  return dispatchers;
}
