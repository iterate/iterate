import {
  assertNever,
  buildDerivedIdempotencyKey,
  implementProcessor,
  type ConsumedEvent,
  type ProcessorStreamApi,
  type StreamEvent,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { CodemodeProcessorContract } from "./contract.ts";
import type {
  CodemodeProcessorLogger,
  CodemodeProcessorSession,
  CodemodeScriptExecutor,
} from "./code-executor.ts";

type CodemodeStreamApi = ProcessorStreamApi<typeof CodemodeProcessorContract>;
type CodemodeConsumedEvent = ConsumedEvent<typeof CodemodeProcessorContract>;

export type CodemodeProcessorDeps = {
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

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
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
            streamApi,
          });
          return;
        default:
          return assertNever(event);
      }
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
  streamApi: CodemodeStreamApi;
}) {
  const startedAt = (args.deps.now ?? (() => new Date()))();
  await args.deps.ensureLiveConsumer?.();
  const session = createProcessorSession({
    ensureLiveConsumer: args.deps.ensureLiveConsumer,
    newId: args.deps.newId,
    scriptExecutionId: args.event.payload.scriptExecutionId,
    sourceEvent: args.event,
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
  ensureLiveConsumer?: () => Promise<void> | void;
  newId?: () => string;
  scriptExecutionId: string;
  sourceEvent: StreamEvent;
  streamApi: CodemodeStreamApi;
}): CodemodeProcessorSession {
  let functionCallSequence = 0;

  return {
    callFunction: async (input) => {
      functionCallSequence += 1;
      const functionCallId =
        input.functionCallId ??
        (args.newId ?? (() => `${args.sourceEvent.offset}.${functionCallSequence}`))();
      const requestedEvent = await args.streamApi.append({
        event: {
          type: "events.iterate.com/codemode/function-call-requested",
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: CodemodeProcessorContract.slug,
            purpose: `function-call-requested:${functionCallSequence}`,
            event: args.sourceEvent,
          }),
          payload: {
            functionCallId,
            input: input.input,
            path: input.path,
            scriptExecutionId: input.scriptExecutionId ?? args.scriptExecutionId,
          },
        },
      });

      await args.ensureLiveConsumer?.();
      return await waitForFunctionCallResult({
        functionCallId: getCommittedFunctionCallId(requestedEvent),
        requestedEvent,
        streamApi: args.streamApi,
      });
    },
  };
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

async function waitForFunctionCallResult(args: {
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
  if (readResult.kind === "succeeded") return readResult.output;
  if (readResult.kind === "failed") throw new Error(serializeErrorMessage(readResult.error));

  for await (const event of args.streamApi.subscribe({ afterOffset: args.requestedEvent.offset })) {
    const result = findFunctionCallResult({
      events: [event],
      functionCallId: args.functionCallId,
    });
    if (result.kind === "succeeded") return result.output;
    if (result.kind === "failed") throw new Error(serializeErrorMessage(result.error));
  }

  throw new Error(`Stream ended before function call ${args.functionCallId} completed.`);
}

function findFunctionCallResult(args: { events: readonly StreamEvent[]; functionCallId: string }):
  | { kind: "missing" }
  | { kind: "succeeded"; output: unknown }
  | {
      kind: "failed";
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
    if (outcome.status === "succeeded") return { kind: "succeeded", output: outcome.output };
    if (outcome.status === "failed") return { kind: "failed", error: outcome.error };
  }

  return { kind: "missing" };
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
