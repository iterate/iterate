import { DurableObject, RpcTarget } from "cloudflare:workers";
import {
  createEventsClient,
  type Event,
  type EventInput,
  type StreamPath,
} from "@iterate-com/events-contract/sdk";
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import type { CallableContext } from "@iterate-com/shared/callable/types.ts";
import type { ToolProviderDescriptor } from "@iterate-com/shared/codemode/types";
import { withD1ObjectCatalog } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import { withDurableObjectCore } from "@iterate-com/shared/durable-object-utils/mixins/with-durable-object-core";
import { withKvInspector } from "@iterate-com/shared/durable-object-utils/mixins/with-kv-inspector";
import { withLifecycleHooks } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withOuterbase } from "@iterate-com/shared/durable-object-utils/mixins/with-outerbase";

export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";

export type CodemodeSessionInitParams = {
  name: string;
  streamPath: StreamPath;
};

export type RegisterToolProviderInput = {
  provider: ToolProviderDescriptor;
};

export type ExecuteScriptInput = {
  code: string;
};

export type CallToolFunctionInput = {
  path: string[];
  payload: unknown;
  scriptExecutionRequestedOffset?: number;
};

export type CodemodeSessionCapability = {
  append(input: EventInput): Promise<Event>;
  callToolFunction(input: CallToolFunctionInput): Promise<unknown>;
  executeScript(input: ExecuteScriptInput): Promise<Event>;
  getStreamPath(): Promise<StreamPath>;
};

type CodemodeSessionEnv = {
  DO_CATALOG: D1Database;
  EVENTS_BASE_URL: string;
  LOADER?: WorkerLoader;
} & Record<string, unknown>;

const CodemodeSessionLifecycleBase = withD1ObjectCatalog<
  CodemodeSessionInitParams,
  Pick<CodemodeSessionEnv, "DO_CATALOG">
>({
  className: "CodemodeSession",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    streamPath: (params) => params.streamPath,
  },
})(withLifecycleHooks<CodemodeSessionInitParams>()(withDurableObjectCore(DurableObject)));

const CodemodeSessionWithOuterbase = withOuterbase({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
})(CodemodeSessionLifecycleBase) as unknown as typeof CodemodeSessionLifecycleBase;

const CodemodeSessionBase = withKvInspector({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
})(CodemodeSessionWithOuterbase) as unknown as typeof CodemodeSessionLifecycleBase;

const TOOL_PROVIDER_REGISTRY_STORAGE_KEY = "codemode.tool-provider-registry.v1";
const EVENT_TYPE_PREFIX = "events.iterate.com/codemode";

export class CodemodeSession extends CodemodeSessionBase<CodemodeSessionEnv> {
  async getStreamPath() {
    const params = await this.ensureStarted();
    return params.streamPath;
  }

  async append(input: EventInput) {
    await this.ensureStarted();
    return await this.appendToStream(input);
  }

  async registerToolProvider(input: RegisterToolProviderInput) {
    await this.ensureStarted();
    const registry = this.readToolProviderRegistry();
    const registryKey = toolProviderRegistryKey(input.provider.path);
    registry[registryKey] = input.provider;
    this.writeToolProviderRegistry(registry);

    return await this.appendToStream({
      type: `${EVENT_TYPE_PREFIX}/tool-provider-registered`,
      payload: {
        descriptor: input.provider,
        path: input.provider.path,
      },
    });
  }

  async executeScript(input: ExecuteScriptInput) {
    const requestedEvent = await this.appendToStream({
      type: `${EVENT_TYPE_PREFIX}/script-execution-requested`,
      payload: {
        code: input.code,
      },
    });

    // Future version: this Durable Object becomes a real events-app stream processor.
    // For now the request event is the durable handoff point and the worker appends
    // follow-up outcome events directly to the same stream.
    void this.runScriptExecution({
      code: input.code,
      scriptExecutionRequestedOffset: requestedEvent.offset,
    }).catch((error: unknown) => {
      console.error("[codemode-session] script execution failed", error);
    });

    return requestedEvent;
  }

  async callToolFunction(input: CallToolFunctionInput) {
    await this.ensureStarted();
    const match = this.resolveToolProvider(input.path);
    const requestedEvent = await this.appendToStream({
      type: `${EVENT_TYPE_PREFIX}/tool-function-call-requested`,
      payload: {
        path: input.path,
        payload: input.payload,
        providerPath: match.provider.path,
        toolFunctionPath: match.toolFunctionPath,
        scriptExecutionRequestedOffset: input.scriptExecutionRequestedOffset,
      },
    });

    try {
      const result = await dispatchCallable({
        callable: match.provider.executeToolFunction,
        payload: {
          path: match.toolFunctionPath,
          payload: input.payload,
          codemodeSessionCapability: this.getScopedRpcTarget(),
        },
        ctx: this.createCallableContext(),
      });

      await this.appendToStream({
        type: `${EVENT_TYPE_PREFIX}/tool-function-call-succeeded`,
        payload: {
          result,
          toolFunctionCallRequestedOffset: requestedEvent.offset,
          scriptExecutionRequestedOffset: input.scriptExecutionRequestedOffset,
        },
      });

      return result;
    } catch (error) {
      await this.appendToStream({
        type: `${EVENT_TYPE_PREFIX}/tool-function-call-failed`,
        payload: {
          error: serializeError(error),
          toolFunctionCallRequestedOffset: requestedEvent.offset,
          scriptExecutionRequestedOffset: input.scriptExecutionRequestedOffset,
        },
      });
      throw error;
    }
  }

  getScopedRpcTarget(): CodemodeSessionCapability {
    return new ScopedCodemodeSessionCapability(this);
  }

  private async runScriptExecution(input: {
    code: string;
    scriptExecutionRequestedOffset: number;
  }) {
    const loader = this.env.LOADER;
    if (!loader) {
      await this.appendToStream({
        type: `${EVENT_TYPE_PREFIX}/script-execution-finished`,
        payload: {
          error: "LOADER binding not available",
          scriptExecutionRequestedOffset: input.scriptExecutionRequestedOffset,
        },
      });
      return;
    }

    try {
      const entrypoint = loader
        .get(`codemode-session-script-${input.scriptExecutionRequestedOffset}`, () => ({
          compatibilityDate: "2025-06-01",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "executor.js",
          modules: {
            "executor.js": buildScriptExecutorModule(input.code),
          },
          globalOutbound: null,
        }))
        .getEntrypoint() as unknown as {
        evaluate(
          capability: CodemodeSessionCapability,
          logger: CodemodeSessionLogTarget,
          scriptExecutionRequestedOffset: number,
        ): Promise<{ error?: string; result: unknown }>;
      };

      const result = await entrypoint.evaluate(
        this.getScopedRpcTarget(),
        new CodemodeSessionLogTarget({
          log: (level, message) =>
            this.appendToStream({
              type: `${EVENT_TYPE_PREFIX}/log-emitted`,
              payload: {
                level,
                message,
                scriptExecutionRequestedOffset: input.scriptExecutionRequestedOffset,
              },
            }),
        }),
        input.scriptExecutionRequestedOffset,
      );

      await this.appendToStream({
        type: `${EVENT_TYPE_PREFIX}/script-execution-finished`,
        payload: {
          ...result,
          scriptExecutionRequestedOffset: input.scriptExecutionRequestedOffset,
        },
      });
    } catch (error) {
      await this.appendToStream({
        type: `${EVENT_TYPE_PREFIX}/script-execution-finished`,
        payload: {
          error: serializeError(error),
          scriptExecutionRequestedOffset: input.scriptExecutionRequestedOffset,
        },
      });
    }
  }

  private async appendToStream(input: EventInput) {
    const params = await this.ensureStarted();
    const client = createEventsClient(this.env.EVENTS_BASE_URL);
    const { event } = await client.append({
      path: params.streamPath,
      event: input,
    });
    return event;
  }

  private createCallableContext(): CallableContext {
    return {
      env: this.env,
      fetch: globalThis.fetch,
    };
  }

  private resolveToolProvider(path: string[]) {
    const registry = this.readToolProviderRegistry();
    const candidates = Object.values(registry)
      .filter((provider) => isPathPrefix(provider.path, path))
      .sort((a, b) => b.path.length - a.path.length);

    const provider = candidates[0];
    if (!provider) {
      throw new Error(`No tool provider registered for path "${path.join(".")}"`);
    }

    return {
      provider,
      toolFunctionPath: path.slice(provider.path.length),
    };
  }

  private readToolProviderRegistry() {
    return (
      this.getDurableObjectKv().get<Record<string, ToolProviderDescriptor>>(
        TOOL_PROVIDER_REGISTRY_STORAGE_KEY,
      ) ?? {}
    );
  }

  private writeToolProviderRegistry(registry: Record<string, ToolProviderDescriptor>) {
    this.getDurableObjectKv().put(TOOL_PROVIDER_REGISTRY_STORAGE_KEY, registry);
  }
}

class ScopedCodemodeSessionCapability extends RpcTarget implements CodemodeSessionCapability {
  readonly #session: CodemodeSession;

  constructor(session: CodemodeSession) {
    super();
    this.#session = session;
  }

  async append(input: EventInput) {
    return await this.#session.append(input);
  }

  async callToolFunction(input: CallToolFunctionInput) {
    return await this.#session.callToolFunction(input);
  }

  async executeScript(input: ExecuteScriptInput) {
    return await this.#session.executeScript(input);
  }

  async getStreamPath() {
    return await this.#session.getStreamPath();
  }
}

class CodemodeSessionLogTarget extends RpcTarget {
  readonly #log: (level: "error" | "log" | "warn", message: string) => Promise<unknown>;

  constructor(options: {
    log: (level: "error" | "log" | "warn", message: string) => Promise<unknown>;
  }) {
    super();
    this.#log = options.log;
  }

  async log(level: string, message: string) {
    await this.#log(level === "error" || level === "warn" ? level : "log", message);
  }
}

function toolProviderRegistryKey(path: string[]) {
  return JSON.stringify(path);
}

function isPathPrefix(prefix: string[], path: string[]) {
  return prefix.every((segment, index) => path[index] === segment);
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

function buildScriptExecutorModule(code: string) {
  return `
import { WorkerEntrypoint } from "cloudflare:workers";

function __stringify(value) {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return "undefined";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function __createCodemodeContext(options) {
  const make = (path = []) => new Proxy(async () => {}, {
    get: (_target, key) => {
      if (key === "then") return undefined;
      if (key === "codemode" && path.length === 0) {
        return {
          append: (input) => options.codemodeSessionCapability.append(input),
          executeScript: (input) => options.codemodeSessionCapability.executeScript(input),
          getStreamPath: () => options.codemodeSessionCapability.getStreamPath(),
        };
      }
      if (typeof key !== "string") return undefined;
      return make([...path, key]);
    },
    apply: async (_target, _thisArg, args) => {
      return await options.codemodeSessionCapability.callToolFunction({
        path,
        payload: args[0],
        scriptExecutionRequestedOffset: options.scriptExecutionRequestedOffset,
      });
    },
  });

  return make();
}

export default class CodeExecutor extends WorkerEntrypoint {
  async evaluate(__codemodeSessionCapability, __logger, __scriptExecutionRequestedOffset) {
    console.log = (...args) => {
      const message = args.map(__stringify).join(" ");
      if (__logger) void __logger.log("log", message);
    };
    console.warn = (...args) => {
      const message = args.map(__stringify).join(" ");
      if (__logger) void __logger.log("warn", message);
    };
    console.error = (...args) => {
      const message = args.map(__stringify).join(" ");
      if (__logger) void __logger.log("error", message);
    };

    try {
      const __userScript = (${code});
      if (typeof __userScript !== "function") {
        throw new Error("Codemode script must evaluate to a function.");
      }
      const ctx = __createCodemodeContext({
        codemodeSessionCapability: __codemodeSessionCapability,
        scriptExecutionRequestedOffset: __scriptExecutionRequestedOffset,
      });
      const result = await __userScript(ctx);
      return { result };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        result: undefined,
      };
    }
  }
}
`;
}

export default {
  fetch() {
    return new Response("ok");
  },
} satisfies ExportedHandler;
