import {
  assertNever,
  buildDerivedIdempotencyKey,
  implementProcessor,
  type ConsumedEvent,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import { assertCallableDispatchContext, dispatchCallable } from "../../callable/runtime.ts";
import type { CallableContext } from "../../callable/types.ts";
import { resolveToolProviderDescriptor } from "../../codemode/resolve.ts";
import type { ToolProviderDescriptor } from "../../codemode/types.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import {
  CodemodeProcessorContract,
  toolProviderRegistryKey,
  type CodemodeState,
} from "./contract.ts";
import type {
  CodemodeEventInput,
  CodemodeProcessorLogger,
  CodemodeProcessorSession,
  CodemodeScriptExecutor,
} from "./code-executor.ts";

type CodemodeStreamApi = ProcessorStreamApi<typeof CodemodeProcessorContract>;
type CodemodeConsumedEvent = ConsumedEvent<typeof CodemodeProcessorContract>;

export type CodemodeProcessorDeps = {
  callableContext: CallableContext;
  ensureLiveConsumer?: () => Promise<void> | void;
  scriptExecutor: CodemodeScriptExecutor;
  now?: () => Date;
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

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
        case "events.iterate.com/codemode/tool-provider-described":
        case "events.iterate.com/codemode/log-emitted":
        case "events.iterate.com/codemode/tool-function-call-succeeded":
        case "events.iterate.com/codemode/tool-function-call-failed":
        case "events.iterate.com/codemode/script-execution-finished":
          return;
        case "events.iterate.com/codemode/tool-provider-registered":
          await appendToolProviderDescription({
            deps,
            event,
            streamApi,
          });
          return;
        case "events.iterate.com/codemode/tool-function-call-requested":
          await dispatchRequestedToolFunction({
            deps,
            event,
            state,
            streamApi,
          });
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

async function appendToolProviderDescription(args: {
  deps: CodemodeProcessorDeps;
  event: Extract<
    CodemodeConsumedEvent,
    { type: "events.iterate.com/codemode/tool-provider-registered" }
  >;
  streamApi: CodemodeStreamApi;
}) {
  const { descriptor, path } = args.event.payload;

  let typeDefinitions: string;
  try {
    assertCallableDispatchContext({
      callable: descriptor.callable,
      ctx: args.deps.callableContext,
    });
    const provider = resolveToolProviderDescriptor(descriptor, args.deps.callableContext);
    typeDefinitions = (await provider.describeToolFunctions()).typeDefinitions;
  } catch (error) {
    typeDefinitions = `/** Error loading types for "${path.join(".")}": ${serializeErrorMessage(error)} */`;
  }

  await args.streamApi.append({
    event: {
      type: "events.iterate.com/codemode/tool-provider-described",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: CodemodeProcessorContract.slug,
        purpose: "tool-provider-description",
        event: args.event,
      }),
      payload: {
        path,
        typeDefinitions,
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
    scriptExecutionRequestedOffset: args.event.offset,
    sourceEvent: args.event,
    state: args.state,
    streamApi: args.streamApi,
  });
  const logger = createProcessorLogger({
    scriptExecutionRequestedOffset: args.event.offset,
    sourceEvent: args.event,
    streamApi: args.streamApi,
  });

  let result: Awaited<ReturnType<CodemodeScriptExecutor>>;
  try {
    result = await args.deps.scriptExecutor({
      code: args.event.payload.code,
      logger,
      scriptExecutionRequestedOffset: args.event.offset,
      session,
      signal: args.signal,
    });
  } catch (error) {
    result = { result: undefined, error: serializeError(error) };
  }

  const finishedAt = (args.deps.now ?? (() => new Date()))();
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/codemode/script-execution-finished",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: CodemodeProcessorContract.slug,
        purpose: "script-execution-finished",
        event: args.event,
      }),
      payload: {
        result: result.result,
        ...(result.error == null ? {} : { error: result.error }),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        scriptExecutionRequestedOffset: args.event.offset,
      },
    },
  });
}

function createProcessorSession(args: {
  callableContext: CallableContext;
  ensureLiveConsumer?: () => Promise<void> | void;
  scriptExecutionRequestedOffset: number;
  sourceEvent: StreamEvent;
  state: CodemodeState;
  streamApi: CodemodeStreamApi;
}): CodemodeProcessorSession {
  let toolCallSequence = 0;
  let nestedScriptSequence = 0;
  const session: CodemodeProcessorSession = {
    append: async (input) =>
      await args.streamApi.append({ event: normalizeCodemodeEventInput(input) as never }),
    callToolFunction: async (input) => {
      toolCallSequence += 1;
      const scriptExecutionRequestedOffset =
        input.scriptExecutionRequestedOffset ?? args.scriptExecutionRequestedOffset;
      const match = resolveToolProvider(args.state.toolProviders, input.path);
      const requestedEvent = await args.streamApi.append({
        event: {
          type: "events.iterate.com/codemode/tool-function-call-requested",
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: CodemodeProcessorContract.slug,
            purpose: `tool-function-call-requested:${toolCallSequence}`,
            event: args.sourceEvent,
          }),
          payload: {
            path: input.path,
            payload: input.payload,
            providerPath: match.provider.path,
            toolFunctionPath: match.toolFunctionPath,
            scriptExecutionRequestedOffset,
          },
        },
      });

      await args.ensureLiveConsumer?.();
      return await waitForToolFunctionCallResult({
        requestedEvent,
        streamApi: args.streamApi,
      });
    },
    executeScript: async (input) => {
      nestedScriptSequence += 1;
      return await args.streamApi.append({
        event: {
          type: "events.iterate.com/codemode/script-execution-requested",
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: CodemodeProcessorContract.slug,
            purpose: `nested-script-execution-requested:${nestedScriptSequence}`,
            event: args.sourceEvent,
          }),
          payload: { code: input.code },
        },
      });
    },
    getStreamPath: async () => args.sourceEvent.streamPath,
  };

  return session;
}

function normalizeCodemodeEventInput(input: CodemodeEventInput): StreamEventInput {
  return {
    ...input,
    payload: input.payload ?? {},
  };
}

function createProcessorLogger(args: {
  scriptExecutionRequestedOffset: number;
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
            scriptExecutionRequestedOffset: args.scriptExecutionRequestedOffset,
          },
        },
      });
    },
  };
}

async function dispatchRequestedToolFunction(args: {
  deps: CodemodeProcessorDeps;
  event: Extract<
    CodemodeConsumedEvent,
    { type: "events.iterate.com/codemode/tool-function-call-requested" }
  >;
  state: CodemodeState;
  streamApi: CodemodeStreamApi;
}) {
  const match = resolveToolProvider(args.state.toolProviders, args.event.payload.path);
  const session = createProcessorSession({
    callableContext: args.deps.callableContext,
    ensureLiveConsumer: args.deps.ensureLiveConsumer,
    scriptExecutionRequestedOffset:
      args.event.payload.scriptExecutionRequestedOffset ?? args.event.offset,
    sourceEvent: args.event,
    state: args.state,
    streamApi: args.streamApi,
  });

  try {
    const result = await dispatchCallable({
      callable: match.provider.callable,
      payload: {
        path: match.toolFunctionPath,
        payload: args.event.payload.payload,
        codemodeSessionCapability: session,
      },
      ctx: args.deps.callableContext,
    });

    await args.streamApi.append({
      event: {
        type: "events.iterate.com/codemode/tool-function-call-succeeded",
        idempotencyKey: buildDerivedIdempotencyKey({
          slug: CodemodeProcessorContract.slug,
          purpose: "tool-function-call-succeeded",
          event: args.event,
        }),
        payload: {
          result,
          toolFunctionCallRequestedOffset: args.event.offset,
          ...(args.event.payload.scriptExecutionRequestedOffset == null
            ? {}
            : {
                scriptExecutionRequestedOffset: args.event.payload.scriptExecutionRequestedOffset,
              }),
        },
      },
    });

    return result;
  } catch (error) {
    await args.streamApi.append({
      event: {
        type: "events.iterate.com/codemode/tool-function-call-failed",
        idempotencyKey: buildDerivedIdempotencyKey({
          slug: CodemodeProcessorContract.slug,
          purpose: "tool-function-call-failed",
          event: args.event,
        }),
        payload: {
          error: serializeError(error),
          toolFunctionCallRequestedOffset: args.event.offset,
          ...(args.event.payload.scriptExecutionRequestedOffset == null
            ? {}
            : {
                scriptExecutionRequestedOffset: args.event.payload.scriptExecutionRequestedOffset,
              }),
        },
      },
    });
    throw error;
  }
}

async function waitForToolFunctionCallResult(args: {
  requestedEvent: StreamEvent;
  streamApi: CodemodeStreamApi;
}) {
  const readEvents = await args.streamApi.read({
    afterOffset: args.requestedEvent.offset,
    beforeOffset: "end",
  });
  const readResult = findToolFunctionCallResult({
    events: readEvents,
    requestedOffset: args.requestedEvent.offset,
  });
  if (readResult.kind === "succeeded") return readResult.result;
  if (readResult.kind === "failed") throw new Error(serializeErrorMessage(readResult.error));

  for await (const event of args.streamApi.subscribe({ afterOffset: args.requestedEvent.offset })) {
    const result = findToolFunctionCallResult({
      events: [event],
      requestedOffset: args.requestedEvent.offset,
    });
    if (result.kind === "succeeded") return result.result;
    if (result.kind === "failed") throw new Error(serializeErrorMessage(result.error));
  }

  throw new Error(
    `Stream ended before tool function call ${args.requestedEvent.offset} completed.`,
  );
}

function findToolFunctionCallResult(args: {
  events: readonly StreamEvent[];
  requestedOffset: number;
}):
  | { kind: "missing" }
  | { kind: "succeeded"; result: unknown }
  | {
      kind: "failed";
      error: unknown;
    } {
  for (const event of args.events) {
    const payload =
      event.payload != null && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    if (payload.toolFunctionCallRequestedOffset !== args.requestedOffset) continue;
    if (event.type === "events.iterate.com/codemode/tool-function-call-succeeded") {
      return { kind: "succeeded", result: payload.result };
    }
    if (event.type === "events.iterate.com/codemode/tool-function-call-failed") {
      return { kind: "failed", error: payload.error };
    }
  }

  return { kind: "missing" };
}

function resolveToolProvider(
  registry: Record<string, ToolProviderDescriptor>,
  path: readonly string[],
) {
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

function isPathPrefix(prefix: readonly string[], path: readonly string[]) {
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

function serializeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
