import {
  assertNever,
  buildDerivedIdempotencyKey,
  implementProcessor,
  type ConsumedEvent,
  type ProcessorStreamApi,
  type StreamEvent,
} from "../stream-processor.ts";
import type { Callable } from "../../callable/types.ts";
import { dispatchCallable } from "../../callable/runtime.ts";
import type { CallableContext } from "../../callable/types.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { CodemodeProcessorContract, type CodemodeState } from "./contract.ts";
import type {
  CodemodeProcessorLogger,
  CodemodeProcessorSession,
  CodemodeScriptExecutor,
} from "./code-executor.ts";

type CodemodeStreamApi = ProcessorStreamApi<typeof CodemodeProcessorContract>;
type CodemodeConsumedEvent = ConsumedEvent<typeof CodemodeProcessorContract>;

export type ExecuteCodemodeFunctionCallInput = {
  args: unknown[];
  codemodeSessionCapability: CodemodeProcessorSession;
  functionCallId: string;
  functionPath: string[];
  invocationKind: "rpc";
  path: string[];
  providerPath: string[];
  scriptExecutionId?: string;
};

export type CodemodeProcessorDeps = {
  buildSessionCapabilityCallable: () => Callable;
  callableContext: CallableContext;
  ensureLiveConsumer?: () => Promise<void> | void;
  newId?: () => string;
  now?: () => Date;
  scriptExecutor: CodemodeScriptExecutor;
};

export function createCodemodeProcessor(deps: CodemodeProcessorDeps) {
  return implementProcessor(CodemodeProcessorContract, {
    firstAttachAfterAppend: { mode: "lookback", milliseconds: 250 },

    async afterAppend({ event, state, streamApi, signal }) {
      await standardProcessorBehavior.afterAppend({
        contract: CodemodeProcessorContract,
        state,
        streamApi,
      });
      await ensureSessionStarted({ deps, state, streamApi });

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
        case "events.iterate.com/codemode/session-started":
        case "events.iterate.com/codemode/tool-provider-registered":
        case "events.iterate.com/codemode/script-execution-completed":
        case "events.iterate.com/codemode/function-call-requested":
        case "events.iterate.com/codemode/function-call-completed":
        case "events.iterate.com/codemode/log-emitted":
          return;
        case "events.iterate.com/codemode/script-execution-requested":
          await executeRequestedScript({
            deps,
            event,
            signal,
            state,
            streamApi,
          });
          return;
        default:
          return assertNever(event);
      }
    },
  });
}

async function ensureSessionStarted(args: {
  deps: CodemodeProcessorDeps;
  state: CodemodeState;
  streamApi: CodemodeStreamApi;
}) {
  if (args.state.sessionStarted) return;

  await args.streamApi.append({
    event: {
      type: "events.iterate.com/codemode/session-started",
      idempotencyKey: "events.iterate.com/codemode/session-started",
      payload: {
        sessionCapabilityCallable: args.deps.buildSessionCapabilityCallable(),
      },
    },
  });
}

async function executeRequestedScript(args: {
  deps: CodemodeProcessorDeps;
  event: Extract<
    CodemodeConsumedEvent,
    { type: "events.iterate.com/codemode/script-execution-requested" }
  >;
  signal: AbortSignal;
  state: CodemodeState;
  streamApi: CodemodeStreamApi;
}) {
  const startedAt = (args.deps.now ?? (() => new Date()))();
  await args.deps.ensureLiveConsumer?.();
  const session = createProcessorSession({
    callableContext: args.deps.callableContext,
    ensureLiveConsumer: args.deps.ensureLiveConsumer,
    newId: args.deps.newId,
    scriptExecutionId: args.event.payload.scriptExecutionId,
    sourceEvent: args.event,
    state: args.state,
    streamApi: args.streamApi,
  });
  const logger = createProcessorLogger({
    scriptExecutionId: args.event.payload.scriptExecutionId,
    sourceEvent: args.event,
    streamApi: args.streamApi,
  });

  let result: Awaited<ReturnType<CodemodeScriptExecutor>>;
  try {
    result = await args.deps.scriptExecutor({
      code: args.event.payload.code,
      logger,
      scriptExecutionId: args.event.payload.scriptExecutionId,
      session,
      signal: args.signal,
    });
  } catch (error) {
    result = { result: undefined, error: serializeError(error) };
  }

  const finishedAt = (args.deps.now ?? (() => new Date()))();
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/codemode/script-execution-completed",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: CodemodeProcessorContract.slug,
        purpose: "script-execution-completed",
        event: args.event,
      }),
      payload: {
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        outcome:
          result.error == null
            ? { status: "succeeded" as const, output: result.result }
            : { status: "failed" as const, error: result.error },
        scriptExecutionId: args.event.payload.scriptExecutionId,
      },
    },
  });
}

function createProcessorSession(args: {
  callableContext: CallableContext;
  ensureLiveConsumer?: () => Promise<void> | void;
  newId?: () => string;
  scriptExecutionId: string;
  sourceEvent: StreamEvent;
  state: CodemodeState;
  streamApi: CodemodeStreamApi;
}): CodemodeProcessorSession {
  let functionCallSequence = 0;
  const session: CodemodeProcessorSession = {
    callFunction: (input) => {
      functionCallSequence += 1;
      const functionCallId =
        input.functionCallId ??
        (args.newId ?? (() => `${args.sourceEvent.offset}.${functionCallSequence}`))();
      const scriptExecutionId = input.scriptExecutionId ?? args.scriptExecutionId;
      return callFunction({
        args: input.args,
        callableContext: args.callableContext,
        ensureLiveConsumer: args.ensureLiveConsumer,
        functionCallId,
        sequence: functionCallSequence,
        scriptExecutionId,
        session,
        sourceEvent: args.sourceEvent,
        state: args.state,
        streamApi: args.streamApi,
        path: input.path,
      });
    },
  };

  return session;
}

async function callFunction(args: {
  args: unknown[];
  callableContext: CallableContext;
  ensureLiveConsumer?: () => Promise<void> | void;
  functionCallId: string;
  path: string[];
  scriptExecutionId: string;
  sequence: number;
  session: CodemodeProcessorSession;
  sourceEvent: StreamEvent;
  state: CodemodeState;
  streamApi: CodemodeStreamApi;
}) {
  const match = resolveToolProvider(args.state.toolProviders, args.path);
  const requestedEvent = await args.streamApi.append({
    event: {
      type: "events.iterate.com/codemode/function-call-requested",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: CodemodeProcessorContract.slug,
        purpose: `function-call-requested:${args.sequence}`,
        event: args.sourceEvent,
      }),
      payload: {
        args: serializeTraceArgs(args.args),
        functionCallId: args.functionCallId,
        functionPath: match.functionPath,
        invocationKind: match.provider.invocation.kind,
        path: args.path,
        providerPath: match.provider.path,
        scriptExecutionId: args.scriptExecutionId,
      },
    },
  });

  if (match.provider.invocation.kind === "event") {
    await args.ensureLiveConsumer?.();
    return await waitForSerializedFunctionCallResult({
      functionCallId: getCommittedFunctionCallId(requestedEvent),
      requestedEvent,
      streamApi: args.streamApi,
    });
  }

  const startedAt = new Date();
  try {
    const result = await dispatchCallable({
      callable: match.provider.invocation.callable,
      ctx: args.callableContext,
      payload: {
        args: args.args,
        codemodeSessionCapability: args.session,
        functionCallId: args.functionCallId,
        functionPath: match.functionPath,
        invocationKind: "rpc" as const,
        path: args.path,
        providerPath: match.provider.path,
        scriptExecutionId: args.scriptExecutionId,
      } satisfies ExecuteCodemodeFunctionCallInput,
    });

    await appendFunctionCallCompleted({
      durationMs: Math.max(0, Date.now() - startedAt.getTime()),
      functionCallId: args.functionCallId,
      functionPath: match.functionPath,
      invocationKind: "rpc",
      outcome: { status: "returned", value: serializeTraceValue(result) },
      path: args.path,
      providerPath: match.provider.path,
      requestedEvent,
      scriptExecutionId: args.scriptExecutionId,
      streamApi: args.streamApi,
    });

    return result;
  } catch (error) {
    const serializedError = serializeError(error);
    await appendFunctionCallCompleted({
      durationMs: Math.max(0, Date.now() - startedAt.getTime()),
      functionCallId: args.functionCallId,
      functionPath: match.functionPath,
      invocationKind: "rpc",
      outcome: { status: "threw", error: serializedError },
      path: args.path,
      providerPath: match.provider.path,
      requestedEvent,
      scriptExecutionId: args.scriptExecutionId,
      streamApi: args.streamApi,
    });
    throw error;
  }
}

function getCommittedFunctionCallId(event: StreamEvent) {
  if (event.type !== "events.iterate.com/codemode/function-call-requested") {
    throw new Error(`Expected function-call-requested event, received ${event.type}.`);
  }

  const payload =
    event.payload != null && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  const functionCallId = payload.functionCallId;
  if (typeof functionCallId !== "string" || functionCallId.trim().length === 0) {
    throw new Error("function-call-requested event is missing functionCallId.");
  }

  return functionCallId;
}

function createProcessorLogger(args: {
  scriptExecutionId: string;
  sourceEvent: StreamEvent;
  streamApi: CodemodeStreamApi;
}): CodemodeProcessorLogger {
  let logSequence = 0;
  return {
    async log(level, message) {
      logSequence += 1;
      await args.streamApi.append({
        event: {
          type: "events.iterate.com/codemode/log-emitted",
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: CodemodeProcessorContract.slug,
            purpose: `log-emitted:${logSequence}`,
            event: args.sourceEvent,
          }),
          payload: {
            level,
            message,
            scriptExecutionId: args.scriptExecutionId,
          },
        },
      });
    },
  };
}

async function waitForSerializedFunctionCallResult(args: {
  functionCallId: string;
  requestedEvent: StreamEvent;
  streamApi: CodemodeStreamApi;
}) {
  const readEvents = await args.streamApi.read({
    afterOffset: args.requestedEvent.offset,
    beforeOffset: "end",
  });
  const readResult = findFunctionCallResult({
    events: readEvents,
    functionCallId: args.functionCallId,
  });
  if (readResult.kind === "returned") return readResult.value;
  if (readResult.kind === "threw") throw new Error(serializeErrorMessage(readResult.error));

  for await (const event of args.streamApi.subscribe({ afterOffset: args.requestedEvent.offset })) {
    const result = findFunctionCallResult({
      events: [event],
      functionCallId: args.functionCallId,
    });
    if (result.kind === "returned") return result.value;
    if (result.kind === "threw") throw new Error(serializeErrorMessage(result.error));
  }

  throw new Error(`Stream ended before function call ${args.functionCallId} completed.`);
}

function findFunctionCallResult(args: { events: readonly StreamEvent[]; functionCallId: string }):
  | { kind: "missing" }
  | { kind: "returned"; value: unknown }
  | {
      kind: "threw";
      error: unknown;
    } {
  for (const event of args.events) {
    if (event.type !== "events.iterate.com/codemode/function-call-completed") continue;
    const payload =
      event.payload != null && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    if (payload.functionCallId !== args.functionCallId) continue;

    const outcome =
      payload.outcome != null && typeof payload.outcome === "object"
        ? (payload.outcome as Record<string, unknown>)
        : {};
    if (outcome.status === "returned") return { kind: "returned", value: outcome.value };
    if (outcome.status === "threw") return { kind: "threw", error: outcome.error };
  }

  return { kind: "missing" };
}

async function appendFunctionCallCompleted(args: {
  durationMs: number;
  functionCallId: string;
  functionPath: string[];
  invocationKind: "event" | "rpc";
  outcome:
    | { status: "returned"; value: unknown }
    | {
        status: "threw";
        error: unknown;
      };
  path: string[];
  providerPath: string[];
  requestedEvent: StreamEvent;
  scriptExecutionId: string;
  streamApi: CodemodeStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/codemode/function-call-completed",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: CodemodeProcessorContract.slug,
        purpose: "function-call-completed",
        event: args.requestedEvent,
      }),
      payload: {
        durationMs: args.durationMs,
        functionCallId: args.functionCallId,
        functionPath: args.functionPath,
        invocationKind: args.invocationKind,
        outcome: args.outcome,
        path: args.path,
        providerPath: args.providerPath,
        scriptExecutionId: args.scriptExecutionId,
      },
    },
  });
}

function resolveToolProvider(registry: CodemodeState["toolProviders"], path: readonly string[]) {
  const candidates = Object.values(registry)
    .filter((provider) => isPathPrefix(provider.path, path))
    .sort((a, b) => b.path.length - a.path.length);
  const provider = candidates[0];

  if (!provider) {
    throw new Error(`No tool provider registered for path "${path.join(".")}"`);
  }

  return {
    functionPath: path.slice(provider.path.length),
    provider,
  };
}

function isPathPrefix(prefix: readonly string[], path: readonly string[]) {
  return prefix.every((segment, index) => path[index] === segment);
}

function serializeTraceValue(value: unknown): unknown {
  if (typeof value === "function") return `[Function${value.name ? ` ${value.name}` : ""}]`;
  if (typeof value === "symbol") return String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof ReadableStream) return { kind: "live", type: "ReadableStream" };
  if (value instanceof Error) return serializeError(value);
  if (value == null || typeof value !== "object") return value;
  if (value.constructor != null && value.constructor !== Object && !Array.isArray(value)) {
    return { kind: "live", type: value.constructor.name };
  }

  try {
    return JSON.parse(
      JSON.stringify(value, (_key, nestedValue) => {
        if (typeof nestedValue === "function") {
          return `[Function${nestedValue.name ? ` ${nestedValue.name}` : ""}]`;
        }
        if (typeof nestedValue === "symbol") return String(nestedValue);
        if (typeof nestedValue === "bigint") return nestedValue.toString();
        if (nestedValue instanceof Error) return serializeError(nestedValue);
        if (nestedValue instanceof ReadableStream) return { kind: "live", type: "ReadableStream" };
        return nestedValue;
      }),
    );
  } catch {
    const constructorName = value.constructor?.name;
    return { kind: "live", type: constructorName ?? "Object" };
  }
}

function serializeTraceArgs(args: unknown[]) {
  return args.map((arg) => serializeTraceValue(arg));
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
