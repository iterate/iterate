import { DurableObject, RpcTarget } from "cloudflare:workers";
import {
  type Event,
  type EventInput,
  STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  type StreamCursor,
  StreamPath,
} from "@iterate-com/shared/streams/types";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import { withD1ObjectCatalog } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import { withDurableObjectCore } from "@iterate-com/shared/durable-object-utils/mixins/with-durable-object-core";
import { withKvInspector } from "@iterate-com/shared/durable-object-utils/mixins/with-kv-inspector";
import { withLifecycleHooks } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withOuterbase } from "@iterate-com/shared/durable-object-utils/mixins/with-outerbase";
import { withStreamProcessorRunner } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import {
  CodemodeProcessorContract,
  type ToolProviderRegistration,
} from "@iterate-com/shared/stream-processors/codemode/contract";
import type {
  CodemodeProcessorLogger,
  CodemodeProcessorSession,
  CodemodeScriptExecutor,
} from "@iterate-com/shared/stream-processors/codemode/code-executor";
import { createCodemodeProcessor } from "@iterate-com/shared/stream-processors/codemode/implementation";
import type { ProcessorStreamApi, StreamEvent } from "@iterate-com/shared/stream-processors";
import type { Callable } from "@iterate-com/shared/callable/types.ts";
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import { createDefaultCodemodeProviderRegistrations } from "~/codemode/default-provider-registrations.ts";
import { resolveProjectStreamPath } from "~/entrypoints/stream-capability.ts";

export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";
export { OutboundMcpFromOurClientCapability } from "~/rpc-targets/outbound-mcp-from-our-client-capability.ts";
export { StreamCapability } from "~/entrypoints/stream-capability.ts";

export type CodemodeSessionInitParams = {
  name: string;
  projectId: string;
  streamPath: StreamPath;
};

export type StartScriptExecutionInput = {
  code: string;
  events?: EventInput[];
  providers?: ToolProviderRegistration[];
};

export type CreateCodemodeSessionInput = {
  code?: string;
  events?: EventInput[];
  providers?: ToolProviderRegistration[];
};

export type CallFunctionInput = {
  args: unknown[];
  functionCallId?: string;
  path: string[];
  scriptExecutionId?: string;
};

export type ReceiveFunctionCallResultInput = {
  durationMs?: number;
  functionCallId: string;
  outcome:
    | { status: "returned"; value: unknown }
    | {
        status: "threw";
        error: unknown;
      };
  functionPath: string[];
  invocationKind: "event" | "rpc";
  path: string[];
  providerPath: string[];
  scriptExecutionId?: string;
};

export type CodemodeSessionEnv = {
  CODEMODE_SESSION: DurableObjectNamespace<CodemodeSession>;
  DO_CATALOG: D1Database;
  LOADER?: WorkerLoader;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
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
      buildSessionCapabilityCallable: () => {
        const session = args.instance as unknown as {
          createSessionCapabilityCallable(): Callable;
        };
        return session.createSessionCapabilityCallable();
      },
      callableContext: {
        env: args.env as Record<string, unknown>,
        // Stored codemode provider callables are often dispatched after the
        // request that created them has ended. A CodemodeSession is a Durable
        // Object, so its `ctx.exports` is the durable-time source of loopback
        // WorkerEntrypoint factories with per-call props.
        exports: (args.ctx as DurableObjectState & { exports?: Record<string, unknown> }).exports,
        fetch,
      },
      ensureLiveConsumer: () => {
        const session = args.instance as unknown as {
          ensureLiveConsumer(): Promise<void>;
        };
        return session.ensureLiveConsumer();
      },
      newId: () => crypto.randomUUID(),
      scriptExecutor: createCloudflareCodemodeScriptExecutor({
        getSessionCapability: () => {
          const session = args.instance as unknown as {
            getCodemodeSessionCapability(): CodemodeProcessorSession;
          };
          return session.getCodemodeSessionCapability();
        },
        loader: args.env.LOADER,
      }),
    });
  },
  streamApi(args) {
    return processorStreamApiFromNamespace({
      projectId: args.initParams.projectId,
      streamNamespace: args.env.STREAM as unknown as StreamDurableObjectNamespace,
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
  readonly #pendingFunctionCallResults = new Map<
    string,
    {
      promise: Promise<unknown>;
      reject(error: unknown): void;
      resolve(value: unknown): void;
    }
  >();

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
    await this.ensureCallableSubscription();
    await this.catchUpStreamProcessor({ signal: AbortSignal.timeout(30_000) });
  }

  async afterAppend(input: { event: Event }) {
    await this.ensureStarted();
    const state = await this.consumeStreamProcessorEvent({ event: input.event as StreamEvent });
    this.resolvePendingFunctionCallFromEvent(input.event as StreamEvent);
    return state;
  }

  async createSession(input: CreateCodemodeSessionInput = {}) {
    const params = await this.ensureStarted();
    await this.ensureLiveConsumer();
    const appendedEvents: Event[] = [];
    const registeredProviderEvents: Event[] = [];

    for (const event of input.events ?? []) {
      appendedEvents.push(await this.streamsEntrypoint().append({ event }));
    }

    const providers = [
      ...createDefaultCodemodeProviderRegistrations({
        projectId: params.projectId,
        streamPath: params.streamPath,
      }),
      ...(input.providers ?? []),
    ];

    for (const provider of providers) {
      const event = await this.appendToolProviderRegisteredEvent({ provider });
      // Session creation is allowed to enqueue code immediately after provider
      // registration. Reduce provider registrations synchronously so the first
      // script block does not race the live stream subscription that will also
      // observe the same events.
      await this.consumeStreamProcessorEvent({ event: event as StreamEvent });
      registeredProviderEvents.push(event);
    }

    const scriptExecutionEvent =
      input.code == null
        ? null
        : await this.streamsEntrypoint().append({
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

  private async appendToolProviderRegisteredEvent(input: { provider: ToolProviderRegistration }) {
    return await this.streamsEntrypoint().append({
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

  async registerToolProvider(input: { provider: ToolProviderRegistration }) {
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
    const functionCallId = input.functionCallId ?? crypto.randomUUID();
    const provider = this.resolveRegisteredProvider(input.path);
    const pending =
      provider.invocation.kind === "event"
        ? this.ensurePendingFunctionCallResult(functionCallId)
        : null;

    const requestedEvent = await this.appendAndConsume({
      type: "events.iterate.com/codemode/function-call-requested",
      payload: {
        args: serializeFunctionCallArgsForEvent(input.args),
        functionCallId,
        functionPath: provider.functionPath,
        invocationKind: provider.invocationKind,
        path: input.path,
        providerPath: provider.providerPath,
        ...(input.scriptExecutionId == null ? {} : { scriptExecutionId: input.scriptExecutionId }),
      },
    });

    if (provider.invocation.kind === "rpc") {
      const startedAt = Date.now();
      try {
        const result = await dispatchCallable({
          callable: provider.invocation.callable,
          ctx: {
            env: this.env as Record<string, unknown>,
            exports: (this.ctx as DurableObjectState & { exports?: Record<string, unknown> })
              .exports,
            fetch,
          },
          payload: {
            args: input.args,
            codemodeSessionCapability: this.getCodemodeSessionCapability(),
            functionCallId,
            functionPath: provider.functionPath,
            invocationKind: "rpc" as const,
            path: input.path,
            providerPath: provider.providerPath,
            ...(input.scriptExecutionId == null
              ? {}
              : { scriptExecutionId: input.scriptExecutionId }),
          },
        });

        await this.receiveFunctionCallResult({
          durationMs: Math.max(0, Date.now() - startedAt),
          functionCallId,
          functionPath: provider.functionPath,
          invocationKind: "rpc",
          outcome: { status: "returned", value: result },
          path: input.path,
          providerPath: provider.providerPath,
          ...(input.scriptExecutionId == null
            ? {}
            : { scriptExecutionId: input.scriptExecutionId }),
        });
        return result;
      } catch (error) {
        await this.receiveFunctionCallResult({
          durationMs: Math.max(0, Date.now() - startedAt),
          functionCallId,
          functionPath: provider.functionPath,
          invocationKind: "rpc",
          outcome: { status: "threw", error },
          path: input.path,
          providerPath: provider.providerPath,
          ...(input.scriptExecutionId == null
            ? {}
            : { scriptExecutionId: input.scriptExecutionId }),
        });
        throw error;
      }
    }

    this.resolvePendingFunctionCallFromEvent(requestedEvent as StreamEvent);

    try {
      return await pending!.promise;
    } finally {
      this.#pendingFunctionCallResults.delete(functionCallId);
    }
  }

  async receiveFunctionCallResult(input: ReceiveFunctionCallResultInput) {
    await this.ensureStarted();
    const event = await this.appendAndConsume({
      type: "events.iterate.com/codemode/function-call-completed",
      idempotencyKey: `codemode:function-call-completed:${input.functionCallId}`,
      payload: {
        ...(input.durationMs == null ? {} : { durationMs: input.durationMs }),
        functionCallId: input.functionCallId,
        functionPath: input.functionPath,
        invocationKind: input.invocationKind,
        outcome: serializeFunctionCallOutcomeForEvent(input.outcome),
        path: input.path,
        providerPath: input.providerPath,
        ...(input.scriptExecutionId == null ? {} : { scriptExecutionId: input.scriptExecutionId }),
      },
    });

    const pending = this.#pendingFunctionCallResults.get(input.functionCallId);
    if (pending != null) {
      if (input.outcome.status === "threw") {
        pending.reject(input.outcome.error);
      } else {
        pending.resolve(input.outcome.value);
      }
    }

    return { event };
  }

  getRunnerState() {
    return this.getStreamProcessorRunnerState();
  }

  private streamsEntrypoint() {
    return processorStreamApiFromNamespace({
      projectId: this.initParams.projectId,
      streamNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      streamPath: this.initParams.streamPath,
    });
  }

  private async ensureCallableSubscription() {
    const stream = await getInitializedStreamStub({
      namespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      projectId: this.initParams.projectId,
      path: this.initParams.streamPath,
    });

    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `codemode-session-callable-subscription:${this.initParams.name}`,
      payload: {
        slug: `codemode-session:${this.initParams.name}`,
        type: "callable",
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "durable-object-namespace",
            bindingName: "CODEMODE_SESSION",
            durableObject: {
              name: this.initParams.name,
            },
          },
          rpcMethod: "afterAppend",
          argsMode: "object",
        },
      },
    });
  }

  private async appendAndConsume(eventInput: EventInput) {
    const event = await this.streamsEntrypoint().append({ event: eventInput });
    await this.consumeStreamProcessorEvent({ event: event as StreamEvent });
    this.resolvePendingFunctionCallFromEvent(event as StreamEvent);
    return event;
  }

  createSessionCapabilityCallable(): Callable {
    return {
      type: "workers-rpc",
      via: {
        type: "env-binding",
        bindingType: "durable-object-namespace",
        bindingName: "CODEMODE_SESSION",
        durableObject: {
          name: this.initParams.name,
        },
      },
      rpcMethod: "getCodemodeSessionCapability",
      argsMode: "object",
    };
  }

  getCodemodeSessionCapability() {
    // Event-based providers reduce the session-started event and invoke this
    // callable when they need the same ergonomic context object as codemode
    // scripts. The returned target is tiny on purpose: it exposes only the
    // function-call protocol, while stream append/read stay ordinary tools.
    return new CodemodeSessionCapabilityTarget({
      callFunction: async (input) => await this.callFunction(input),
    });
  }

  private ensurePendingFunctionCallResult(functionCallId: string) {
    const existing = this.#pendingFunctionCallResults.get(functionCallId);
    if (existing != null) return existing;

    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (error: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const pending = {
      promise,
      reject: rejectResult,
      resolve: resolveResult,
    };
    this.#pendingFunctionCallResults.set(functionCallId, pending);
    return pending;
  }

  private resolvePendingFunctionCallFromEvent(event: StreamEvent) {
    if (event.type !== "events.iterate.com/codemode/function-call-completed") return;
    const payload = event.payload as {
      functionCallId: string;
      outcome: { status: "returned"; value: unknown } | { status: "threw"; error: unknown };
    };
    const pending = this.#pendingFunctionCallResults.get(payload.functionCallId);
    if (pending == null) return;

    if (payload.outcome.status === "threw") {
      pending.reject(payload.outcome.error);
    } else {
      pending.resolve(payload.outcome.value);
    }
  }

  private resolveRegisteredProvider(path: string[]) {
    const state = this.getStreamProcessorRunnerState().state;
    const candidates = Object.values(state.toolProviders)
      .filter((provider) => provider.path.every((segment, index) => path[index] === segment))
      .sort((left, right) => right.path.length - left.path.length);
    const provider = candidates[0];
    if (provider == null) {
      throw new Error(`No codemode provider registered for ${path.join(".")}.`);
    }

    // Keeping providerPath and functionPath separate makes providers
    // mount-depth agnostic: the same Slack capability can be mounted at
    // `slack`, `team.slack`, or a future tenant-specific prefix.
    return {
      functionPath: path.slice(provider.path.length),
      invocation: provider.invocation,
      invocationKind: provider.invocation.kind,
      providerPath: provider.path,
    };
  }
}

function processorStreamApiFromNamespace(args: {
  projectId: string;
  streamNamespace: StreamDurableObjectNamespace;
  streamPath: StreamPath;
}): CodemodeSessionStreamApi {
  return {
    async append(input) {
      const stream = await getInitializedStreamStub({
        namespace: args.streamNamespace,
        projectId: args.projectId,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.append(input.event as EventInput);
    },
    async read(input = {}) {
      const stream = await getInitializedStreamStub({
        namespace: args.streamNamespace,
        projectId: args.projectId,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.history({
        after: toEventsCursor(input.afterOffset),
        before: toEventsCursor(input.beforeOffset ?? "end"),
      });
    },
    async *subscribe(input = {}) {
      void input;
      throw new Error("CodemodeSession processors receive live events through afterAppend RPC.");
    },
  };
}

function resolveProcessorStreamPath(input: { basePath: StreamPath; pathInput?: string }) {
  if (input.pathInput == null) {
    return input.basePath;
  }

  const trimmedPath = input.pathInput.trim();
  if (!trimmedPath) {
    throw new Error("Stream path is required.");
  }

  if (trimmedPath.startsWith("/")) {
    return resolveProjectStreamPath(trimmedPath);
  }

  const relativePath = trimmedPath.replace(/^\.\//, "").replace(/^\/+/, "");
  return StreamPath.parse(
    input.basePath === "/" ? `/${relativePath}` : `${input.basePath}/${relativePath}`,
  );
}

function createCloudflareCodemodeScriptExecutor(input: {
  getSessionCapability?: () => CodemodeProcessorSession;
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
          compatibilityDate: "2026-04-27",
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

      // The generic shared processor session waits for event-provider results
      // by subscribing to the stream. In OS2 this host receives live
      // completions through `afterAppend` and a pending-promise map, so dynamic
      // worker scripts must call back through the Durable Object session
      // capability instead of the generic processor facade.
      return await entrypoint.evaluate(
        new CodemodeSessionCapabilityTarget(input.getSessionCapability?.() ?? session),
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

  callFunction(input: CallFunctionInput) {
    return this.#session.callFunction(input);
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
      if (key === "console" && path.length === 0) {
        return {
          log: (...args) => console.log(...args),
          warn: (...args) => console.warn(...args),
          error: (...args) => console.error(...args),
        };
      }
      if (typeof key !== "string") return undefined;
      return make([...path, key]);
    },
    apply: (_target, _thisArg, args) => {
      return options.codemodeSessionCapability.callFunction({
        args,
        path,
        scriptExecutionId: options.scriptExecutionId,
      });
    },
  });

  return make();
}

export default class CodeExecutor extends WorkerEntrypoint {
  async evaluate(__codemodeSessionCapability, __logger, __scriptExecutionId) {
    const __codemodeFetch = (...args) => {
      return __codemodeSessionCapability.callFunction({
        args,
        path: ["fetch"],
        scriptExecutionId: __scriptExecutionId,
      });
    };
    globalThis.fetch = __codemodeFetch;

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

function serializeErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error != null && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function serializeFunctionCallOutcomeForEvent(input: ReceiveFunctionCallResultInput["outcome"]) {
  if (input.status === "threw") {
    return {
      status: "threw" as const,
      error: serializeFunctionCallValueForEvent(input.error),
    };
  }

  return {
    status: "returned" as const,
    value: serializeFunctionCallValueForEvent(input.value),
  };
}

function serializeFunctionCallArgsForEvent(args: unknown[]) {
  return args.map((arg) => serializeFunctionCallValueForEvent(arg));
}

function serializeFunctionCallValueForEvent(value: unknown): unknown {
  if (typeof value === "function") {
    return {
      kind: "live-value",
      type: "function",
    };
  }
  if (typeof value === "bigint") {
    return {
      kind: "non-json-value",
      type: "bigint",
      value: value.toString(),
    };
  }
  if (typeof value === "symbol" || typeof value === "undefined") {
    return {
      kind: "non-json-value",
      type: typeof value,
    };
  }
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Response) {
    return {
      kind: "live-value",
      status: value.status,
      statusText: value.statusText,
      type: "response",
    };
  }
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) {
    return {
      kind: "live-value",
      type: "readable-stream",
    };
  }
  if (
    value != null &&
    typeof value === "object" &&
    value.constructor != null &&
    value.constructor !== Object &&
    !Array.isArray(value)
  ) {
    return {
      kind: "live-value",
      type: value.constructor.name,
    };
  }

  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      return {
        kind: "non-json-value",
        type: typeof value,
      };
    }
    return JSON.parse(json) as unknown;
  } catch {
    return {
      kind: "non-json-value",
      type:
        value != null && typeof value === "object" && value.constructor != null
          ? value.constructor.name
          : typeof value,
    };
  }
}

export default {
  fetch() {
    return new Response("ok");
  },
} satisfies ExportedHandler;
