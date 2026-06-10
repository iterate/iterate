import { DurableObject, RpcTarget } from "cloudflare:workers";
import { z } from "zod";
import {
  Event,
  type EventInput,
  type StreamCursor,
  StreamPath,
} from "@iterate-com/shared/streams/types";
import { withDurableObjectCore } from "@iterate-com/shared/durable-object-utils/mixins/with-durable-object-core";
import { withKvInspector } from "@iterate-com/shared/durable-object-utils/mixins/with-kv-inspector";
import {
  deriveDurableObjectNameFromStructuredName,
  NotInitializedError,
  withLifecycleHooks,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withOuterbase } from "@iterate-com/shared/durable-object-utils/mixins/with-outerbase";
import type { Callable } from "@iterate-com/shared/callable/types.ts";
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/streams/workers/stream-processor-host";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import type { ToolProviderRegistration } from "~/domains/codemode/stream-processors/codemode/contract.ts";
import { CodemodeProcessor } from "~/domains/codemode/stream-processors/codemode/implementation.ts";
import type {
  CodemodeProcessorLogger,
  CodemodeProcessorSession,
  CodemodeScriptExecutionResult,
  CodemodeScriptExecutor,
} from "~/domains/codemode/stream-processors/codemode/code-executor.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/new-stream-runtime.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-capability.ts";
import { createOutboundMcpFromOurClientToolProviderRegistration } from "~/domains/outbound-mcp-client/utils/outbound-mcp-provider-registration.ts";
import { createOpenApiProviderRegistration } from "~/rpc-targets/openapi-provider-registration.ts";
import { type ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";

export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";
export { OutboundMcpFromOurClientCapability } from "~/domains/outbound-mcp-client/entrypoints/outbound-mcp-from-our-client-capability.ts";
export { StreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";

export type CodemodeSessionStructuredName = {
  projectId: string;
  streamPath: StreamPath;
};

const CodemodeSessionStructuredName = z.object({
  projectId: z.string(),
  streamPath: StreamPath,
});

const CodemodeProviderPath = z
  .array(z.string().min(1))
  .min(1)
  .refine((path) => path[0] !== "codemode", {
    message: "Provider path cannot start with reserved segment codemode.",
  });

const ConnectToMcpServerInput = z.object({
  headers: z.record(z.string(), z.string()).optional(),
  instructions: z.string().optional(),
  path: CodemodeProviderPath,
  url: z.string().url(),
});

const ConnectToOpenApiServerInput = z.object({
  baseUrl: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  instructions: z.string().optional(),
  path: CodemodeProviderPath,
  specUrl: z.string().url(),
});

export type StartScriptExecutionInput = {
  code: string;
  events?: EventInput[];
};

export type CreateCodemodeSessionInput = {
  code?: string;
  events?: EventInput[];
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
  PROJECT?: DurableObjectNamespace<ProjectDurableObject>;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
} & Record<string, unknown>;

type CodemodeSessionStreamApi = {
  append(args: { event: EventInput; streamPath?: string }): Promise<Event>;
  appendBatch(args: { events: EventInput[]; streamPath?: string }): Promise<Event[]>;
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
type CodemodeExecutorEntrypoint = {
  evaluate(
    capability: CodemodeSessionCapabilityTarget,
    logger: CodemodeLoggerTarget,
    scriptExecutionId: string,
    vars: Record<string, string>,
  ): Promise<{ error?: string; result: unknown }>;
};
type DisposableRpcValue = {
  [Symbol.dispose](): void;
};

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

const CodemodeSessionLifecycleBase = withLifecycleHooks<
  CodemodeSessionStructuredName,
  undefined,
  Pick<CodemodeSessionEnv, "DO_CATALOG">
>({
  d1ObjectCatalog: {
    className: "CodemodeSession",
    getDatabase: (env) => env.DO_CATALOG,
    indexes: {
      projectId: (params) => params.projectId,
      streamPath: (params) => params.streamPath,
    },
  },
  nameSchema: CodemodeSessionStructuredName,
})(withDurableObjectCore(DurableObject));

const CodemodeSessionWithOuterbase = withOuterbase({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
})(CodemodeSessionLifecycleBase) as unknown as typeof CodemodeSessionLifecycleBase;

const CodemodeSessionBase = withKvInspector({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
})(CodemodeSessionWithOuterbase) as unknown as typeof CodemodeSessionLifecycleBase;

export class CodemodeSession extends CodemodeSessionBase<CodemodeSessionEnv> {
  host = createStreamProcessorHost(this.ctx);
  codemode = this.host.add(
    "codemode",
    (deps) =>
      new CodemodeProcessor({
        ...deps,
        buildSessionCapabilityCallable: () => this.createSessionCapabilityCallable(),
        getSessionCapability: () => this.getCodemodeSessionCapability(),
        scriptExecutor: (input) => this.#executeCodemodeScript(input),
      }),
  );

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
      await this.ensureProcessorSubscription();
      this.ctx.waitUntil(
        this.waitForProcessorCatchUp().catch((error) => {
          console.error("[codemode-processor-catch-up] failed", error);
        }),
      );
    });
  }

  /**
   * Subscription entry point dialed by the Stream DO through the callable
   * subscriber appended in `ensureProcessorSubscription` — or, for routed
   * Slack-agent streams, through the bootstrap subscription appended by the
   * Slack integration BEFORE anything has initialized this Durable Object.
   * Initialize from the runtime name first: the hosted codemode processor's
   * batch side effects (e.g. `session-started`'s capability callable) read
   * `this.name`, and a NotInitializedError thrown mid-ingest is swallowed by
   * the host while the stream pump advances — silently skipping events.
   */
  async requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    await this.ensureStartedOrInitializeFromRuntimeName();
    return await this.host.requestStreamSubscription(args);
  }

  private async ensureStartedOrInitializeFromRuntimeName() {
    try {
      return await this.ensureStarted();
    } catch (error) {
      if (!(error instanceof NotInitializedError)) throw error;
      const runtimeName = this.getDurableObjectName();
      if (runtimeName == null) throw error;
      return await this.initialize({ name: runtimeName });
    }
  }

  async getStreamPath() {
    const params = await this.ensureStarted();
    return params.streamPath;
  }

  async ensureLiveConsumer() {
    await this.ensureStarted();
    await this.ensureProcessorSubscription();
    await this.waitForProcessorCatchUp();
  }

  async afterAppend(input: { event: Event }) {
    await this.ensureStarted();
    // Event-mediated providers complete by appending function-call-completed
    // back to the stream. Resolve the live script waiter before waiting for the
    // codemode processor to catch up; otherwise the processor can be waiting on
    // the script that is waiting on this completion.
    this.resolvePendingFunctionCallFromEvent(input.event);
    await this.waitForProcessorCatchUp();
    return await this.getRunnerState();
  }

  async createSession(input: CreateCodemodeSessionInput = {}) {
    const params = await this.ensureStarted();
    await this.ensureProcessorSubscription();
    const appendedEvents: Event[] = [];
    const registeredProviderEvents: Event[] = [];

    for (const event of input.events ?? []) {
      const appendedEvent = await this.streamsEntrypoint().append({ event });
      appendedEvents.push(appendedEvent);
      if (appendedEvent.type === "events.iterate.com/codemode/tool-provider-registered") {
        registeredProviderEvents.push(appendedEvent);
      }
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
    return await this.appendToolProviderRegisteredEvent(input);
  }

  async executeScript(input: { code: string }) {
    return (await this.startScriptExecution(input)).event;
  }

  async callFunction(input: CallFunctionInput) {
    await this.ensureStarted();
    await this.ensureLiveConsumer();
    const functionCallId = input.functionCallId ?? crypto.randomUUID();
    const builtin = this.resolveCodemodeBuiltin(input.path);
    if (builtin != null) {
      // Temporary duplication with the shared codemode processor. This is not
      // the design we want long-term: `codemode` should be owned by exactly
      // one session capability implementation. For now the OS host and the
      // portable processor both need this branch so the internal path is always
      // available, still records a normal requested/completed event pair, and
      // does not require a tool-provider-registered event.
      const requestedEvent = await this.appendAndConsume({
        type: "events.iterate.com/codemode/function-call-requested",
        payload: {
          args: serializeFunctionCallArgsForEvent(input.args),
          functionCallId,
          functionPath: builtin.functionPath,
          invocationKind: "rpc",
          path: input.path,
          providerPath: builtin.providerPath,
          ...(input.scriptExecutionId == null
            ? {}
            : { scriptExecutionId: input.scriptExecutionId }),
        },
      });
      const startedAt = Date.now();
      try {
        const result = await this.runCodemodeBuiltin({
          args: input.args,
          functionCallId,
          functionPath: builtin.functionPath,
          path: input.path,
          providerPath: builtin.providerPath,
          requestedEvent,
          scriptExecutionId: input.scriptExecutionId,
        });
        await this.receiveFunctionCallResult({
          durationMs: Math.max(0, Date.now() - startedAt),
          functionCallId,
          functionPath: builtin.functionPath,
          invocationKind: "rpc",
          outcome: { status: "returned", value: result },
          path: input.path,
          providerPath: builtin.providerPath,
          ...(input.scriptExecutionId == null
            ? {}
            : { scriptExecutionId: input.scriptExecutionId }),
        });
        return result;
      } catch (error) {
        await this.receiveFunctionCallResult({
          durationMs: Math.max(0, Date.now() - startedAt),
          functionCallId,
          functionPath: builtin.functionPath,
          invocationKind: "rpc",
          outcome: { status: "threw", error },
          path: input.path,
          providerPath: builtin.providerPath,
          ...(input.scriptExecutionId == null
            ? {}
            : { scriptExecutionId: input.scriptExecutionId }),
        });
        throw error;
      }
    }

    const provider = await this.resolveRegisteredProvider(input.path);
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
            exports: this.ctx.exports,
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

    return await this.waitForEventProviderResult({
      afterOffset: requestedEvent.offset,
      functionCallId,
    });
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

  async getRunnerState() {
    await this.ensureStarted();
    const runtime = this.host.runtimeState("codemode");
    // The two legacy cursors collapse onto the single class-model checkpoint,
    // exactly like the retired runner DO's runtimeState() already did.
    const offset = runtime.snapshot?.offset ?? 0;
    return {
      processorName: runtime.processorName,
      snapshot: runtime.snapshot,
      subscription: runtime.subscription,
      state: runtime.snapshot?.state ?? null,
      reducedThroughOffset: offset,
      afterAppendCompletedThroughOffset: offset,
    };
  }

  /**
   * Runs a codemode script in a dynamically-loaded worker. This is the
   * `scriptExecutor` dependency of the hosted CodemodeProcessor; building the
   * Cloudflare executor lazily keeps project identity resolution
   * (`ensureStarted`) out of Durable Object field initialization.
   */
  async #executeCodemodeScript(
    input: Parameters<CodemodeScriptExecutor>[0],
  ): Promise<CodemodeScriptExecutionResult> {
    const { projectId } = await this.ensureStarted();
    const projectCapability = this.ctx.exports.ProjectCapability({
      props: { projectId },
    });
    const execute = createCloudflareCodemodeScriptExecutor({
      env: {
        PROJECT: projectCapability,
        project: projectCapability,
      },
      getSessionCapability: () => this.getCodemodeSessionCapability(),
      loader: this.env.LOADER,
      outboundFetch: projectCapability,
      wrapSessionCapability: false,
    });
    return await execute(input);
  }

  private streamsEntrypoint(): CodemodeSessionStreamApi {
    return processorStreamApiFromNamespace({
      namespace: this.structuredName.projectId,
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      streamPath: this.structuredName.streamPath,
    });
  }

  private async ensureProcessorSubscription() {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.structuredName.projectId,
      path: this.structuredName.streamPath,
    });

    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      // The ":callable" suffix is deliberate: the legacy built-in subscriber was
      // appended under the un-suffixed key, and idempotency would otherwise drop
      // this new callable subscriber event on pre-migration streams.
      idempotencyKey: `codemode-session-processor-subscription:${this.name}:workers-rpc:callable`,
      payload: {
        subscriptionKey: codemodeProcessorSubscriptionKey({
          projectId: this.structuredName.projectId,
          streamPath: this.structuredName.streamPath,
        }),
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "CODEMODE_SESSION",
          durableObjectName: this.name,
          processorName: "codemode",
        }),
      },
    });
  }

  private async waitForProcessorCatchUp() {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.structuredName.projectId,
      path: this.structuredName.streamPath,
    });
    // The subscription pump filters delivery by the contract's consumed event
    // types, so the processor's checkpoint trails the stream head whenever the
    // tail holds non-codemode events. Catch up to the last CONSUMED event, not
    // to the stream max offset.
    const consumedTypes = new Set<string>(this.codemode.contract.consumes);
    const targetOffset =
      (await stream.history({ before: "end" }))
        .filter((event) => consumedTypes.has(event.type))
        .at(-1)?.offset ?? 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await this.codemode.snapshot()).offset >= targetOffset) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async appendAndConsume(eventInput: EventInput) {
    const event = await this.streamsEntrypoint().append({ event: eventInput });
    await this.waitForProcessorCatchUp();
    this.resolvePendingFunctionCallFromEvent(event);
    return event;
  }

  private async waitForEventProviderResult(input: { afterOffset: number; functionCallId: string }) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const result = findFunctionCallCompletedEvent({
        events: await this.streamsEntrypoint().read({
          afterOffset: input.afterOffset,
          beforeOffset: "end",
        }),
        functionCallId: input.functionCallId,
      });
      if (result?.outcome.status === "returned") return result.outcome.value;
      if (result?.outcome.status === "threw") throw new Error(String(result.outcome.error));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timed out waiting for event provider call ${input.functionCallId}.`);
  }

  createSessionCapabilityCallable(): Callable {
    return {
      type: "workers-rpc",
      via: {
        type: "env-binding",
        bindingType: "durable-object-namespace",
        bindingName: "CODEMODE_SESSION",
        durableObject: {
          name: this.name,
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

  private resolvePendingFunctionCallFromEvent(event: Event) {
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

  private async resolveRegisteredProvider(path: string[]) {
    // The hosted processor instance IS the codemode reducer for this stream, so
    // read its typed reduced state directly instead of round-tripping through
    // the serialized runner-state view.
    const { state } = await this.codemode.snapshot();
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

  private resolveCodemodeBuiltin(path: string[]) {
    if (path[0] !== "codemode") return null;
    return {
      functionPath: path.slice(1),
      providerPath: ["codemode"],
    };
  }

  private async runCodemodeBuiltin(input: {
    args: unknown[];
    functionCallId: string;
    functionPath: string[];
    path: string[];
    providerPath: string[];
    requestedEvent: Event;
    scriptExecutionId?: string;
  }) {
    const name = input.functionPath.join(".");
    if (name === "ping") return "pong";
    if (name === "connectToMcpServer") {
      const args = parseUnaryCodemodeBuiltinArgs({
        args: input.args,
        name,
        schema: ConnectToMcpServerInput,
      });
      return await this.appendToolProviderRegisteredEvent({
        provider: createOutboundMcpFromOurClientToolProviderRegistration({
          headers: args.headers,
          instructions: args.instructions,
          path: args.path,
          serverUrl: args.url,
        }),
      });
    }
    if (name === "connectToOpenApiServer") {
      const args = parseUnaryCodemodeBuiltinArgs({
        args: input.args,
        name,
        schema: ConnectToOpenApiServerInput,
      });
      return await this.appendToolProviderRegisteredEvent({
        provider: createOpenApiProviderRegistration({
          baseUrl: args.baseUrl,
          headers: args.headers,
          instructions: args.instructions,
          path: args.path,
          specUrl: args.specUrl,
        }),
      });
    }
    if (name === "debugInfo") {
      return {
        args: serializeFunctionCallArgsForEvent(input.args),
        functionCallId: input.functionCallId,
        functionPath: input.functionPath,
        invocationKind: "rpc" as const,
        path: input.path,
        providerPath: input.providerPath,
        requestedOffset: input.requestedEvent.offset,
        ...(input.scriptExecutionId == null ? {} : { scriptExecutionId: input.scriptExecutionId }),
        streamPath: this.structuredName.streamPath,
      };
    }

    throw new Error(`Unknown codemode builtin codemode.${name}`);
  }
}

export function getCodemodeSessionName(input: {
  projectId: string;
  streamPath: StreamPath | string;
}) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: {
      projectId: input.projectId,
      streamPath: StreamPath.parse(input.streamPath),
    },
  });
}

export function codemodeProcessorSubscriptionKey(input: {
  projectId: string;
  streamPath: StreamPath | string;
}) {
  return `codemode-session:${getCodemodeSessionName(input)}`;
}

function parseUnaryCodemodeBuiltinArgs<T>(input: {
  args: unknown[];
  name: string;
  schema: z.ZodType<T>;
}) {
  if (input.args.length !== 1) {
    throw new Error(`ctx.codemode.${input.name} requires exactly one object argument.`);
  }

  const result = input.schema.safeParse(input.args[0]);
  if (result.success) return result.data;

  throw new Error(
    `Invalid ctx.codemode.${input.name} argument: ${result.error.issues
      .map((issue) => {
        const path = issue.path.length === 0 ? "input" : `input.${issue.path.join(".")}`;
        return `${path}: ${issue.message}`;
      })
      .join("; ")}`,
  );
}

function processorStreamApiFromNamespace(args: {
  namespace: string;
  durableObjectNamespace: StreamDurableObjectNamespace;
  streamPath: StreamPath;
}): CodemodeSessionStreamApi {
  return {
    async append(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.append(input.event as EventInput);
    },
    async appendBatch(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.appendBatch(input.events as EventInput[]);
    },
    async read(input = {}) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      const events = await stream.history({
        after: toEventsCursor(input.afterOffset),
        before: toEventsCursor(input.beforeOffset ?? "end"),
      });
      return events.map((event) => Event.parse(event));
    },
    async *subscribe(input = {}) {
      void input;
      yield* [];
      throw new Error("CodemodeSession processors receive live events through afterAppend RPC.");
    },
  };
}

function findFunctionCallCompletedEvent(input: {
  events: readonly Event[];
  functionCallId: string;
}):
  | {
      outcome: { status: "returned"; value: unknown } | { status: "threw"; error: unknown };
    }
  | undefined {
  for (const event of input.events) {
    if (event.type !== "events.iterate.com/codemode/function-call-completed") continue;
    const payload = event.payload as {
      functionCallId?: unknown;
      outcome?: unknown;
    };
    if (payload.functionCallId !== input.functionCallId) continue;
    const outcome = payload.outcome as
      | { status: "returned"; value: unknown }
      | { status: "threw"; error: unknown }
      | undefined;
    if (outcome?.status === "returned" || outcome?.status === "threw") {
      return { outcome };
    }
  }
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
    return resolveStreamPath(trimmedPath);
  }

  const relativePath = trimmedPath.replace(/^\.\//, "").replace(/^\/+/, "");
  return StreamPath.parse(
    input.basePath === "/" ? `/${relativePath}` : `${input.basePath}/${relativePath}`,
  );
}

export function createCloudflareCodemodeScriptExecutor(input: {
  env: Record<string, unknown>;
  getSessionCapability?: () => CodemodeProcessorSession | Promise<CodemodeProcessorSession>;
  loader: WorkerLoader | undefined;
  outboundFetch: Fetcher;
  wrapSessionCapability?: boolean;
}): CodemodeScriptExecutor {
  return async ({ code, logger, scriptExecutionId, session, vars }) => {
    if (!input.loader) {
      return {
        result: undefined,
        error: "LOADER binding not available",
      };
    }

    let entrypoint: CodemodeExecutorEntrypoint | undefined;

    try {
      entrypoint = input.loader
        .load({
          compatibilityDate: "2026-04-27",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "executor.js",
          modules: {
            "executor.js": buildScriptExecutorModule(),
            "user-code.js": buildUserCodeModule(code),
          },
          env: input.env,
          globalOutbound: input.outboundFetch,
        })
        .getEntrypoint() as unknown as CodemodeExecutorEntrypoint;

      // The generic shared processor session waits for event-provider results
      // by subscribing to the stream. In OS this host receives live
      // completions through `afterAppend` and a pending-promise map, so dynamic
      // worker scripts must call back through the Durable Object session
      // capability instead of the generic processor facade.
      const sessionCapability = (await input.getSessionCapability?.()) ?? session;
      const evaluation = await entrypoint.evaluate(
        (input.wrapSessionCapability === false
          ? sessionCapability
          : new CodemodeSessionCapabilityTarget(
              sessionCapability,
            )) as CodemodeSessionCapabilityTarget,
        new CodemodeLoggerTarget(logger),
        scriptExecutionId,
        vars,
      );
      try {
        // `evaluate()` is itself a Workers RPC call into the dynamic executor.
        // Clone the request-shaped result into this Durable Object before
        // disposing the RPC result object. If we later intentionally support
        // returning live handles from a codemode script, this is one of the
        // boundaries that must become an explicit ownership transfer instead.
        return structuredClone(evaluation);
      } finally {
        disposeRpcResult(evaluation);
      }
    } catch (error) {
      return {
        result: undefined,
        error: serializeError(error),
      };
    } finally {
      disposeRpcResult(entrypoint);
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

/**
 * Builds the tiny WorkerEntrypoint module that runs user-authored codemode.
 *
 * The executor deliberately lives in a dynamically-loaded Worker rather than in
 * this Durable Object. That gives every script a fresh global scope and lets us
 * pass Cloudflare RPC objects, functions, streams, and Durable Object stubs
 * through native Workers RPC instead of flattening everything to JSON.
 *
 * Two first-party Cloudflare RPC rules drive the shape below:
 *
 * 1. Promise pipelining:
 *    https://developers.cloudflare.com/workers/runtime-apis/rpc/#promise-pipelining
 *
 *    Cloudflare RPC calls return custom thenables, not ordinary Promises. Those
 *    thenables are also speculative stubs, so code can do:
 *
 *      await ctx.agents.create().doThing({ value: 21 })
 *
 *    without first awaiting `ctx.agents.create()`. Returning the original RPC
 *    thenable from the context proxy is therefore not an optimization detail; it
 *    is the API contract we need for codemode providers that expose handle-like
 *    objects such as sandboxes, repos, browser pages, or agents.
 *
 * 2. RPC lifecycle and explicit disposal:
 *    https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#disposers-and-rpctarget-classes
 *
 *    A client-side stub keeps the server-side RpcTarget alive. Cloudflare can
 *    sometimes dispose stubs automatically, but their docs recommend explicit
 *    disposal for performance and correctness. LLM-authored codemode cannot be
 *    expected to write `using` or call `[Symbol.dispose]()` reliably, especially
 *    when a provider returns a handle only as an intermediate step in a
 *    pipelined expression. The generated context below therefore tracks every
 *    provider call result it observes, waits for those calls to settle, and
 *    disposes any returned RPC stubs at the end of script evaluation.
 *
 * Important limitation: this automatic ownership model assumes codemode scripts
 * are request-shaped. If we later let a script intentionally return a live RPC
 * handle to its caller, this cleanup boundary must become explicit: the returned
 * handle would need to be removed from the executor-owned disposal set, or
 * duplicated/leased to the caller with a documented lifetime.
 */
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
	  // These sets are executor-local. They are intentionally not part of the
	  // durable codemode event stream: they manage live Cloudflare RPC resources,
	  // while the stream records serializable traces of requested/completed calls.
	  const trackedDisposables = new Set();
	  const pendingTrackers = [];

	  function trackDisposable(value) {
	    // Cloudflare RPC stubs expose Symbol.dispose on the caller side. Calling it
	    // tells the remote isolate that the server-side RpcTarget can eventually be
	    // collected. This includes objects returned directly from providers and
	    // intermediate handles returned only to support promise-pipelined calls.
	    if (
	      value != null &&
	      (typeof value === "object" || typeof value === "function") &&
	      typeof value[Symbol.dispose] === "function"
	    ) {
	      trackedDisposables.add(value);
	    }
	    return value;
	  }

	  function trackCallResult(result) {
      // Keep returning Cloudflare's original RPC thenable so promise pipelining
      // still works. Wrapping this in a native Promise before returning would
      // erase the speculative-stub behavior that makes expressions like
      // "ctx.agents.create().doThing()" a single pipelined RPC chain.
      //
      // The thenable itself can also be disposable. Cloudflare's own promise
      // pipelining examples use "using promiseForCounter = service.getCounter()",
      // which disposes the promise/stub object, not merely the awaited value.
      // Track both the original thenable and the eventual resolved value.
      trackDisposable(result);
      //
      // We attach a side observer with Promise.resolve(...).then(...) only for
      // lifetime tracking. The user still receives the original thenable, while
	    // the executor remembers the eventual stub and disposes it in evaluate's
	    // finally block.
	    pendingTrackers.push(Promise.resolve(result).then(trackDisposable, () => undefined));
	    return result;
	  }

	  // This Proxy is the codemode "ctx" object given to user-authored snippets.
	  // It is intentionally not a real RpcTarget stub. Codemode needs an open
	  // tool namespace where an LLM can write ctx.workspace.git.status(...),
	  // ctx.fetch(...), or future provider paths without the host predeclaring
	  // every method as a JavaScript class member. Each property read appends a
	  // path segment; the final function call sends { path, args } to the owning
	  // CodemodeSession Durable Object via callFunction(...). The host then
	  // resolves the provider and records/disposes any returned RPC stubs.
	  //
	  // Returning undefined for then/catch/finally is required. Promise
	  // machinery probes those names; if the path proxy looked thenable, "await
	  // ctx.workspace" would call the tool path instead of preserving the path
	  // recorder.
	  //
	  // References:
	  // - Workers RPC stubs use Proxy objects:
	  //   https://developers.cloudflare.com/workers/runtime-apis/rpc/
	  // - Cap'n Web documents the same proxy/stub model:
	  //   https://github.com/cloudflare/capnweb
	  const make = (path = []) => new Proxy(async () => {}, {
	    get: (_target, key) => {
	      if (key === "then" || key === "catch" || key === "finally") return undefined;
	      if (key === "abortSignal" && path.length === 0) return options.abortSignal;
	      if (key === "__disposeTrackedRpcStubs" && path.length === 0) {
	        return async () => {
	          // Wait for all provider-call observations before disposing. Without
	          // this, a pipelined call could still be resolving to its intermediate
	          // handle while the script has already returned its final value.
	          await Promise.allSettled(pendingTrackers);
	          for (const disposable of trackedDisposables) {
	            try {
	              disposable[Symbol.dispose]();
	            } catch {}
	          }
	          trackedDisposables.clear();
	        };
	      }
	      if (key === "console" && path.length === 0) {
	        return {
	          log: (...args) => console.log(...args),
	          warn: (...args) => console.warn(...args),
            error: (...args) => console.error(...args),
          };
        }
        if (key === "env" && path.length === 0) return options.env;
        if (key === "vars" && path.length === 1 && path[0] === "codemode") return options.vars;
        if (typeof key !== "string") return undefined;
        return make([...path, key]);
	    },
	    apply: (_target, _thisArg, args) => {
	      return trackCallResult(options.codemodeSessionCapability.callFunction({
	        args,
	        path,
	        scriptExecutionId: options.scriptExecutionId,
	      }));
	    },
	  });

  return make();
}

	export default class CodeExecutor extends WorkerEntrypoint {
	  async evaluate(__codemodeSessionCapability, __logger, __scriptExecutionId, __codemodeVars) {
	    const __pendingLogs = [];
	    const __emitLog = (level, args) => {
	      const message = args.map(__stringify).join(" ");
	      // Console output is also RPC back to the host Durable Object. If we
	      // fire-and-forget these calls, the worker test runtime can tear down
	      // while the log RPC is still pending, and real callers can observe a
	      // completed script before its log-emitted events have landed.
	      if (__logger) __pendingLogs.push(__logger.log(level, message).catch(() => undefined));
	    };
	    const __codemodeFetch = (...args) => {
	      return __codemodeSessionCapability.callFunction({
	        args,
        path: ["fetch"],
        scriptExecutionId: __scriptExecutionId,
      });
    };
	    globalThis.fetch = __codemodeFetch;

	    console.log = (...args) => {
	      __emitLog("log", args);
	    };
	    console.warn = (...args) => {
	      __emitLog("warn", args);
	    };
	    console.error = (...args) => {
	      __emitLog("error", args);
	    };
	    const ctx = __createCodemodeContext({
	      codemodeSessionCapability: __codemodeSessionCapability,
	      env: this.env,
	      scriptExecutionId: __scriptExecutionId,
	      vars: __codemodeVars,
	    });

	    try {
	      if (typeof __userScript !== "function") {
	        throw new Error("Codemode script must evaluate to a function.");
	      }
	      const result = await __userScript(ctx);
	      await Promise.allSettled(__pendingLogs);
	      return { result };
	    } catch (error) {
	      await Promise.allSettled(__pendingLogs);
	      return {
	        error: error instanceof Error ? error.message : String(error),
	        result: undefined,
	      };
	    } finally {
	      // This is the codemode execution ownership boundary. The script has
	      // produced its serializable result, all log RPCs have been awaited, and
	      // any provider handles created along the way are no longer meant to
	      // escape this dynamic Worker invocation.
	      await ctx.__disposeTrackedRpcStubs();
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

function disposeRpcResult(value: unknown) {
  if (isDisposableRpcValue(value)) {
    value[Symbol.dispose]();
  }
}

function isDisposableRpcValue(value: unknown): value is DisposableRpcValue {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as Partial<DisposableRpcValue>)[Symbol.dispose] === "function"
  );
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
