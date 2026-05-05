import { DurableObject, RpcTarget } from "cloudflare:workers";
import { type Event, type EventInput, type StreamPath } from "@iterate-com/events-contract";
import {
  assertCallableDispatchContext,
  dispatchCallable,
} from "@iterate-com/shared/callable/runtime.ts";
import type { CallableContext } from "@iterate-com/shared/callable/types.ts";
import { ToolProviderDescriptor } from "@iterate-com/shared/codemode/types";
import { withD1ObjectCatalog } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import { withDurableObjectCore } from "@iterate-com/shared/durable-object-utils/mixins/with-durable-object-core";
import { withKvInspector } from "@iterate-com/shared/durable-object-utils/mixins/with-kv-inspector";
import { withLifecycleHooks } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withOuterbase } from "@iterate-com/shared/durable-object-utils/mixins/with-outerbase";
import { createEventsClient } from "~/lib/events-client.ts";

export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";
// CodemodeSession dispatches stored MCP Provider Descriptors through an
// MCP_CLIENT_BRIDGE Durable Object namespace binding. Cloudflare requires every
// bound Durable Object class to be exported by the Worker module that owns the
// binding, even when the class implementation lives in a shared rpc-target file.
// https://developers.cloudflare.com/durable-objects/api/namespace/
export { McpClientBridge } from "~/rpc-targets/mcp-client-bridge.ts";

export type CodemodeSessionInitParams = {
  name: string;
  projectId: string;
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
    projectId: (params) => params.projectId,
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
    this.applyAppendedEventToSessionState(input);
    return await this.appendToStream(input);
  }

  async registerToolProvider(input: RegisterToolProviderInput) {
    await this.ensureStarted();
    validateToolProviderDispatchContext({
      callableContext: this.createCallableContext(),
      provider: input.provider,
    });

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
    // Keep the lifecycle read explicit before scheduling background execution.
    // The follow-up outcome events are appended after this RPC returns, so we
    // want startup failures to surface on the request RPC instead of being
    // swallowed by the detached execution promise.
    await this.ensureStarted();
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
        callable: match.provider.callable,
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
        .load({
          compatibilityDate: "2025-06-01",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "executor.js",
          modules: {
            "executor.js": buildScriptExecutorModule(),
            "user-code.js": buildUserCodeModule(input.code),
          },
          globalOutbound: null,
        })
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

  private applyAppendedEventToSessionState(input: EventInput) {
    if (input.type !== `${EVENT_TYPE_PREFIX}/tool-provider-registered`) return;

    const payload =
      input.payload != null && typeof input.payload === "object"
        ? (input.payload as Record<string, unknown>)
        : {};
    const descriptor = ToolProviderDescriptor.safeParse(payload.descriptor);
    if (!descriptor.success) return;

    try {
      validateToolProviderDispatchContext({
        callableContext: this.createCallableContext(),
        provider: descriptor.data,
      });
    } catch (error) {
      console.warn("[codemode-session] appended provider descriptor is not dispatchable", error);
      return;
    }

    const registry = this.readToolProviderRegistry();
    registry[toolProviderRegistryKey(descriptor.data.path)] = descriptor.data;
    this.writeToolProviderRegistry(registry);
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

function validateToolProviderDispatchContext(input: {
  callableContext: CallableContext;
  provider: ToolProviderDescriptor;
}) {
  try {
    assertCallableDispatchContext({
      callable: input.provider.callable,
      ctx: input.callableContext,
    });
  } catch (error) {
    throw new Error(
      `Tool provider "${input.provider.path.join(".")}" cannot be dispatched by this Codemode Session worker: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function buildScriptExecutorModule() {
  // The user's code is inserted as JavaScript source because Cloudflare's
  // dynamically loaded Workers run with string eval disabled. WorkerLoader is
  // the sandbox boundary here; the outer catch below reports module/evaluation
  // errors back onto the CodemodeSession event stream.
  // https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/
  return `
import { WorkerEntrypoint } from "cloudflare:workers";
import __userScript from "./user-code.js";

function __stringify(value) {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return "undefined";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function __createCodemodeContext(options) {
  const make = (path = []) => new Proxy(async () => {}, {
    get: (_target, key) => {
      if (key === "then" || key === "catch" || key === "finally") return undefined;
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

function buildUserCodeModule(code: string) {
  return `const __userScript = (${code});
export default __userScript;
`;
}

export default {
  fetch() {
    return new Response("ok");
  },
} satisfies ExportedHandler;
