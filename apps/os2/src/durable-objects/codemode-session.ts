import { DurableObject, RpcTarget } from "cloudflare:workers";
import {
  type Event,
  type EventInput,
  type StreamCursor,
  type StreamPath,
} from "@iterate-com/events-contract";
import { withD1ObjectCatalog } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import { withDurableObjectCore } from "@iterate-com/shared/durable-object-utils/mixins/with-durable-object-core";
import { withKvInspector } from "@iterate-com/shared/durable-object-utils/mixins/with-kv-inspector";
import { withLifecycleHooks } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withOuterbase } from "@iterate-com/shared/durable-object-utils/mixins/with-outerbase";
import { withStreamProcessorRunner } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import {
  CodemodeProcessorContract,
  type ToolProviderDocumentation,
} from "@iterate-com/shared/stream-processors/codemode/contract";
import type {
  CodemodeProcessorLogger,
  CodemodeProcessorSession,
  CodemodeScriptExecutor,
} from "@iterate-com/shared/stream-processors/codemode/code-executor";
import { createCodemodeProcessor } from "@iterate-com/shared/stream-processors/codemode/implementation";
import type { ProcessorStreamApi, StreamEvent } from "@iterate-com/shared/stream-processors";
import { createEventsClient } from "~/lib/events-client.ts";

export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";
export { McpClientBridge } from "~/rpc-targets/mcp-client-bridge.ts";

export type CodemodeSessionInitParams = {
  name: string;
  projectId: string;
  streamPath: StreamPath;
};

export type StartScriptExecutionInput = {
  code: string;
  events?: EventInput[];
  providers?: ToolProviderDocumentation[];
};

export type CreateCodemodeSessionInput = {
  code?: string;
  events?: EventInput[];
  providers?: ToolProviderDocumentation[];
};

export type CallFunctionInput = {
  functionCallId?: string;
  input: unknown;
  path: string[];
  scriptExecutionId?: string;
};

export type CodemodeSessionEnv = {
  DO_CATALOG: D1Database;
  EVENTS_BASE_URL: string;
  LOADER?: WorkerLoader;
} & Record<string, unknown>;

type CodemodeSessionStreamApi = ProcessorStreamApi<typeof CodemodeProcessorContract> & {
  append(args: { event: EventInput; streamPath?: string }): Promise<Event>;
  read(args?: {
    streamPath?: string;
    afterOffset?: number | "start" | "end";
    beforeOffset?: number | "start" | "end";
  }): Promise<Event[]>;
  subscribe(args?: {
    streamPath?: string;
    afterOffset?: number | "start" | "end";
    signal?: AbortSignal;
  }): AsyncIterable<Event>;
};

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

const CodemodeSessionRunnerBase = withStreamProcessorRunner<
  CodemodeSessionInitParams,
  CodemodeSessionEnv,
  typeof CodemodeProcessorContract
>({
  processor(args) {
    return createCodemodeProcessor({
      ensureLiveConsumer: () => {
        const session = args.instance as unknown as {
          ensureLiveConsumer(): Promise<void>;
        };
        return session.ensureLiveConsumer();
      },
      newId: () => crypto.randomUUID(),
      scriptExecutor: createCloudflareCodemodeScriptExecutor({
        loader: args.env.LOADER,
      }),
    });
  },
  streamApi(args) {
    return createStreamApi({
      env: args.env,
      streamPath: args.initParams.streamPath,
    });
  },
})(CodemodeSessionLifecycleBase);

const CodemodeSessionWithOuterbase = withOuterbase({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
})(CodemodeSessionRunnerBase) as unknown as typeof CodemodeSessionRunnerBase;

const CodemodeSessionBase = withKvInspector({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
})(CodemodeSessionWithOuterbase) as unknown as typeof CodemodeSessionRunnerBase;

export class CodemodeSession extends CodemodeSessionBase<CodemodeSessionEnv> {
  #consumerCount = 0;

  constructor(ctx: DurableObjectState, env: CodemodeSessionEnv) {
    super(ctx, env);
    this.registerOnInstanceWake(async () => {
      await this.ensureLiveConsumer();
    });
  }

  async getStreamPath() {
    const params = await this.ensureStarted();
    return params.streamPath;
  }

  async ensureLiveConsumer() {
    await this.ensureStarted();
    this.#consumerCount += 1;
    const signal = AbortSignal.timeout(5 * 60_000);
    const task = this.startStreamProcessorSubscription({ signal })
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          console.error("[codemode-session] stream processor consumer failed", error);
        }
      })
      .finally(() => {
        this.#consumerCount = Math.max(0, this.#consumerCount - 1);
      });
    this.ctx.waitUntil(task);
  }

  async createSession(input: CreateCodemodeSessionInput = {}) {
    const params = await this.ensureStarted();
    await this.ensureLiveConsumer();
    const streamApi = this.createStreamApi();
    const appendedEvents: Event[] = [];
    const registeredProviderEvents: Event[] = [];

    for (const event of input.events ?? []) {
      appendedEvents.push(await streamApi.append({ event }));
    }

    for (const provider of input.providers ?? []) {
      registeredProviderEvents.push(await this.appendToolProviderRegisteredEvent({ provider }));
    }

    const scriptExecutionEvent =
      input.code == null
        ? null
        : await streamApi.append({
            event: {
              type: "events.iterate.com/codemode/script-execution-requested",
              payload: {
                code: input.code,
                scriptExecutionId: crypto.randomUUID(),
              },
            },
          });

    return {
      appendedEvents,
      registeredProviderEvents,
      scriptExecutionEvent,
      streamPath: params.streamPath,
    };
  }

  private async appendToolProviderRegisteredEvent(input: { provider: ToolProviderDocumentation }) {
    return await this.createStreamApi().append({
      event: {
        type: "events.iterate.com/codemode/tool-provider-registered",
        idempotencyKey: `codemode:tool-provider-registered:${input.provider.path.join("/")}`,
        payload: input.provider,
      },
    });
  }

  async startScriptExecution(input: StartScriptExecutionInput) {
    const session = await this.createSession(input);
    if (!session.scriptExecutionEvent) {
      throw new Error("startScriptExecution requires code.");
    }

    return {
      appendedEvents: session.appendedEvents,
      event: session.scriptExecutionEvent,
      registeredProviderEvents: session.registeredProviderEvents,
      streamPath: session.streamPath,
    };
  }

  async registerToolProvider(input: { provider: ToolProviderDocumentation }) {
    await this.ensureStarted();
    await this.ensureLiveConsumer();
    const event = await this.appendToolProviderRegisteredEvent(input);
    await this.consumeStreamProcessorEvent({ event: event as StreamEvent });
    return event;
  }

  async executeScript(input: { code: string }) {
    return (await this.startScriptExecution(input)).event;
  }

  async callFunction(input: CallFunctionInput) {
    await this.ensureStarted();
    await this.ensureLiveConsumer();
    return await this.appendAndConsume({
      type: "events.iterate.com/codemode/function-call-requested",
      payload: {
        functionCallId: input.functionCallId ?? crypto.randomUUID(),
        input: input.input,
        path: input.path,
        ...(input.scriptExecutionId == null ? {} : { scriptExecutionId: input.scriptExecutionId }),
      },
    });
  }

  getRunnerState() {
    return this.getStreamProcessorRunnerState();
  }

  private createStreamApi() {
    return createStreamApi({ env: this.env, streamPath: this.initParams.streamPath });
  }

  private async appendAndConsume(eventInput: EventInput) {
    const event = await this.createStreamApi().append({ event: eventInput });
    await this.consumeStreamProcessorEvent({ event: event as StreamEvent });
    return event;
  }
}

function createStreamApi(args: {
  env: Pick<CodemodeSessionEnv, "EVENTS_BASE_URL">;
  streamPath: StreamPath;
}): CodemodeSessionStreamApi {
  const resolveStreamPath = (path: string | undefined): StreamPath => {
    return (path ?? args.streamPath) as StreamPath;
  };

  return {
    async append(input) {
      const { event } = await createEventsClient(args.env.EVENTS_BASE_URL).append({
        path: resolveStreamPath(input.streamPath),
        event: input.event as EventInput,
      });
      return event;
    },
    async read(input = {}) {
      const events: Event[] = [];
      const stream = await createEventsClient(args.env.EVENTS_BASE_URL).stream({
        path: resolveStreamPath(input.streamPath),
        afterOffset: toEventsCursor(input.afterOffset),
        beforeOffset: toEventsCursor(input.beforeOffset ?? "end"),
      });

      for await (const event of stream) {
        events.push(event);
      }

      return events;
    },
    async *subscribe(input = {}) {
      const stream = await createEventsClient(args.env.EVENTS_BASE_URL).stream(
        {
          path: resolveStreamPath(input.streamPath),
          afterOffset: toEventsCursor(input.afterOffset),
        },
        { signal: input.signal },
      );

      for await (const event of stream) {
        yield event;
      }
    },
  };
}

function createCloudflareCodemodeScriptExecutor(input: {
  loader: WorkerLoader | undefined;
}): CodemodeScriptExecutor {
  return async ({ code, logger, scriptExecutionId, session }) => {
    if (!input.loader) {
      return {
        result: undefined,
        error: "LOADER binding not available",
      };
    }

    try {
      const entrypoint = input.loader
        .load({
          compatibilityDate: "2025-06-01",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "executor.js",
          modules: {
            "executor.js": buildScriptExecutorModule(),
            "user-code.js": buildUserCodeModule(code),
          },
          globalOutbound: null,
        })
        .getEntrypoint() as unknown as {
        evaluate(
          capability: CodemodeSessionCapabilityTarget,
          logger: CodemodeLoggerTarget,
          scriptExecutionId: string,
        ): Promise<{ error?: string; result: unknown }>;
      };

      return await entrypoint.evaluate(
        new CodemodeSessionCapabilityTarget(session),
        new CodemodeLoggerTarget(logger),
        scriptExecutionId,
      );
    } catch (error) {
      return {
        result: undefined,
        error: serializeError(error),
      };
    }
  };
}

class CodemodeSessionCapabilityTarget extends RpcTarget {
  readonly #session: CodemodeProcessorSession;

  constructor(session: CodemodeProcessorSession) {
    super();
    this.#session = session;
  }

  async callFunction(input: CallFunctionInput) {
    return await this.#session.callFunction(input);
  }
}

class CodemodeLoggerTarget extends RpcTarget {
  readonly #logger: CodemodeProcessorLogger;

  constructor(logger: CodemodeProcessorLogger) {
    super();
    this.#logger = logger;
  }

  async log(level: string, message: string) {
    await this.#logger.log(level === "error" || level === "warn" ? level : "log", message);
  }
}

function buildScriptExecutorModule() {
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
      if (key === "abortSignal" && path.length === 0) return options.abortSignal;
      if (typeof key !== "string") return undefined;
      return make([...path, key]);
    },
    apply: async (_target, _thisArg, args) => {
      return await options.codemodeSessionCapability.callFunction({
        input: args[0],
        path,
        scriptExecutionId: options.scriptExecutionId,
      });
    },
  });

  return make();
}

export default class CodeExecutor extends WorkerEntrypoint {
  async evaluate(__codemodeSessionCapability, __logger, __scriptExecutionId) {
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
        scriptExecutionId: __scriptExecutionId,
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

function toEventsCursor(value: number | "start" | "end" | undefined): StreamCursor | undefined {
  return typeof value === "number" && value <= 0 ? "start" : value;
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

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export default {
  fetch() {
    return new Response("ok");
  },
} satisfies ExportedHandler;
