import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "../stream-processor.ts";
import { Callable } from "../../callable/types.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

const CodemodeId = z.string().trim().min(1);
const CodemodePath = z.array(z.string().min(1)).min(1);
const CodemodeFunctionPath = z.array(z.string().min(1));
const ToolProviderInvocation = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("event"),
  }),
  z.object({
    callable: Callable,
    kind: z.literal("rpc"),
  }),
]);
const ToolProviderRegistration = z.object({
  instructions: z.string().trim().min(1),
  invocation: ToolProviderInvocation,
  path: CodemodePath,
});
const CodemodeError = z.unknown();
const ScriptExecutionOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    output: z.unknown(),
  }),
  z.object({
    status: z.literal("failed"),
    error: CodemodeError,
  }),
]);
const FunctionCallOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("returned"),
    value: z.unknown(),
  }),
  z.object({
    status: z.literal("threw"),
    error: CodemodeError,
  }),
]);
const InvocationKind = z.enum(["event", "rpc"]);

export type ToolProviderRegistration = z.output<typeof ToolProviderRegistration>;

export const CodemodeProcessorContract = defineProcessorContract({
  slug: "codemode",
  version: "0.4.0",
  description:
    "Runs project-scoped codemode scripts from durable stream events and records minimal script/function-call telemetry.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    sessionStarted: z.boolean().default(false),
    sessionCapabilityCallable: Callable.optional(),
    toolProviders: z.record(z.string(), ToolProviderRegistration).default({}),
    scriptExecutions: z
      .record(
        z.string(),
        z.discriminatedUnion("status", [
          z.object({
            status: z.literal("requested"),
            code: z.string(),
            scriptExecutionId: CodemodeId,
          }),
          z.object({
            status: z.literal("completed"),
            durationMs: z.number().int().nonnegative().optional(),
            outcome: ScriptExecutionOutcome,
            scriptExecutionId: CodemodeId,
          }),
        ]),
      )
      .default({}),
    functionCalls: z
      .record(
        z.string(),
        z.discriminatedUnion("status", [
          z.object({
            status: z.literal("requested"),
            args: z.array(z.unknown()),
            functionCallId: CodemodeId,
            functionPath: CodemodeFunctionPath,
            invocationKind: InvocationKind,
            path: CodemodePath,
            providerPath: CodemodePath,
            scriptExecutionId: CodemodeId.optional(),
          }),
          z.object({
            status: z.literal("completed"),
            durationMs: z.number().int().nonnegative().optional(),
            functionCallId: CodemodeId,
            functionPath: CodemodeFunctionPath,
            invocationKind: InvocationKind,
            outcome: FunctionCallOutcome,
            path: CodemodePath,
            providerPath: CodemodePath,
            scriptExecutionId: CodemodeId.optional(),
          }),
        ]),
      )
      .default({}),
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps],
  events: {
    "events.iterate.com/codemode/session-started": {
      description:
        "The codemode processor initialized this stream and published the session capability callable.",
      payloadSchema: z.object({
        sessionCapabilityCallable: Callable,
      }),
    },
    "events.iterate.com/codemode/tool-provider-registered": {
      description: "Model-visible instructions and invocation mode for codemode tool functions.",
      payloadSchema: ToolProviderRegistration,
    },
    "events.iterate.com/codemode/script-execution-requested": {
      description: "A codemode script should run against the stream's documented functions.",
      payloadSchema: z.object({
        code: z.string().min(1),
        scriptExecutionId: CodemodeId,
      }),
    },
    "events.iterate.com/codemode/script-execution-completed": {
      description: "A codemode script completed with either an output or a serialized error.",
      payloadSchema: z.object({
        durationMs: z.number().int().nonnegative().optional(),
        outcome: ScriptExecutionOutcome,
        scriptExecutionId: CodemodeId,
      }),
    },
    "events.iterate.com/codemode/function-call-requested": {
      description:
        "A codemode script or function implementation requested a documented function path.",
      payloadSchema: z.object({
        args: z.array(z.unknown()),
        functionCallId: CodemodeId,
        functionPath: CodemodeFunctionPath,
        invocationKind: InvocationKind,
        path: CodemodePath,
        providerPath: CodemodePath,
        scriptExecutionId: CodemodeId.optional(),
      }),
    },
    "events.iterate.com/codemode/function-call-completed": {
      description:
        "A requested function call completed with either an output or a serialized error.",
      payloadSchema: z.object({
        durationMs: z.number().int().nonnegative().optional(),
        functionCallId: CodemodeId,
        functionPath: CodemodeFunctionPath,
        invocationKind: InvocationKind,
        outcome: FunctionCallOutcome,
        path: CodemodePath,
        providerPath: CodemodePath,
        scriptExecutionId: CodemodeId.optional(),
      }),
    },
    "events.iterate.com/codemode/log-emitted": {
      description: "A codemode script emitted a log line.",
      payloadSchema: z.object({
        level: z.enum(["log", "warn", "error"]),
        message: z.string(),
        scriptExecutionId: CodemodeId.optional(),
      }),
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    "events.iterate.com/codemode/session-started",
    "events.iterate.com/codemode/tool-provider-registered",
    "events.iterate.com/codemode/script-execution-requested",
    "events.iterate.com/codemode/script-execution-completed",
    "events.iterate.com/codemode/function-call-requested",
    "events.iterate.com/codemode/function-call-completed",
    "events.iterate.com/codemode/log-emitted",
  ],
  emits: [
    ...standardProcessorBehavior.emits,
    "events.iterate.com/codemode/session-started",
    "events.iterate.com/codemode/script-execution-requested",
    "events.iterate.com/codemode/script-execution-completed",
    "events.iterate.com/codemode/function-call-requested",
    "events.iterate.com/codemode/function-call-completed",
    "events.iterate.com/codemode/log-emitted",
  ],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({ state, event, contract });

    switch (event.type) {
      case CoreProcessorRegisteredEventType:
      case "events.iterate.com/codemode/log-emitted":
        return nextState;
      case "events.iterate.com/codemode/session-started":
        return {
          ...nextState,
          sessionCapabilityCallable: event.payload.sessionCapabilityCallable,
          sessionStarted: true,
        };
      case "events.iterate.com/codemode/tool-provider-registered":
        return {
          ...nextState,
          toolProviders: {
            ...nextState.toolProviders,
            [toolProviderRegistryKey(event.payload.path)]: event.payload,
          },
        };
      case "events.iterate.com/codemode/script-execution-requested":
        return {
          ...nextState,
          scriptExecutions: {
            ...nextState.scriptExecutions,
            [event.payload.scriptExecutionId]: {
              status: "requested" as const,
              code: event.payload.code,
              scriptExecutionId: event.payload.scriptExecutionId,
            },
          },
        };
      case "events.iterate.com/codemode/script-execution-completed":
        return {
          ...nextState,
          scriptExecutions: {
            ...nextState.scriptExecutions,
            [event.payload.scriptExecutionId]: {
              status: "completed" as const,
              ...(event.payload.durationMs == null ? {} : { durationMs: event.payload.durationMs }),
              outcome: event.payload.outcome,
              scriptExecutionId: event.payload.scriptExecutionId,
            },
          },
        };
      case "events.iterate.com/codemode/function-call-requested":
        return {
          ...nextState,
          functionCalls: {
            ...nextState.functionCalls,
            [event.payload.functionCallId]: {
              status: "requested" as const,
              args: event.payload.args,
              functionCallId: event.payload.functionCallId,
              functionPath: event.payload.functionPath,
              invocationKind: event.payload.invocationKind,
              path: event.payload.path,
              providerPath: event.payload.providerPath,
              ...(event.payload.scriptExecutionId == null
                ? {}
                : { scriptExecutionId: event.payload.scriptExecutionId }),
            },
          },
        };
      case "events.iterate.com/codemode/function-call-completed":
        return {
          ...nextState,
          functionCalls: {
            ...nextState.functionCalls,
            [event.payload.functionCallId]: {
              status: "completed" as const,
              ...(event.payload.durationMs == null ? {} : { durationMs: event.payload.durationMs }),
              functionCallId: event.payload.functionCallId,
              functionPath: event.payload.functionPath,
              invocationKind: event.payload.invocationKind,
              outcome: event.payload.outcome,
              path: event.payload.path,
              providerPath: event.payload.providerPath,
              ...(event.payload.scriptExecutionId == null
                ? {}
                : { scriptExecutionId: event.payload.scriptExecutionId }),
            },
          },
        };
      default:
        return assertNever(event);
    }
  },
});

export function reduceCodemodeEvents(args: {
  events: readonly StreamEvent[];
  state?: CodemodeState;
}): CodemodeState {
  return reduceProcessorEvents({
    contract: CodemodeProcessorContract,
    events: args.events,
    state: args.state,
  });
}

export function toolProviderRegistryKey(path: readonly string[]) {
  return JSON.stringify(path);
}

export type CodemodeState = z.infer<typeof CodemodeProcessorContract.stateSchema>;
