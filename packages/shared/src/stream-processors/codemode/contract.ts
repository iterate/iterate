import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

const CodemodeId = z.string().trim().min(1);
const CodemodePath = z.array(z.string().min(1)).min(1);
const ToolProviderDocumentation = z.object({
  docs: z.string().trim().min(1),
  instructions: z.string().trim().min(1).optional(),
  path: CodemodePath,
  typeDefinitions: z.string().trim().min(1).optional(),
});
const CodemodeError = z.unknown();
const CodemodeOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    output: z.unknown(),
  }),
  z.object({
    status: z.literal("failed"),
    error: CodemodeError,
  }),
]);

export type ToolProviderDocumentation = z.output<typeof ToolProviderDocumentation>;

export const CodemodeProcessorContract = defineProcessorContract({
  slug: "codemode",
  version: "0.3.0",
  description:
    "Runs project-scoped codemode scripts from durable stream events and records minimal script/function-call telemetry.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    toolProviders: z.record(z.string(), ToolProviderDocumentation).default({}),
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
            outcome: CodemodeOutcome,
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
            functionCallId: CodemodeId,
            input: z.unknown(),
            path: CodemodePath,
            scriptExecutionId: CodemodeId.optional(),
          }),
          z.object({
            status: z.literal("completed"),
            durationMs: z.number().int().nonnegative().optional(),
            functionCallId: CodemodeId,
            outcome: CodemodeOutcome,
            path: CodemodePath,
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
    "events.iterate.com/codemode/tool-provider-registered": {
      description: "Model-visible documentation for functions available to codemode scripts.",
      payloadSchema: ToolProviderDocumentation,
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
        outcome: CodemodeOutcome,
        scriptExecutionId: CodemodeId,
      }),
    },
    "events.iterate.com/codemode/function-call-requested": {
      description:
        "A codemode script or function implementation requested a documented function path.",
      payloadSchema: z.object({
        functionCallId: CodemodeId,
        input: z.unknown(),
        path: CodemodePath,
        scriptExecutionId: CodemodeId.optional(),
      }),
    },
    "events.iterate.com/codemode/function-call-completed": {
      description:
        "A requested function call completed with either an output or a serialized error.",
      payloadSchema: z.object({
        durationMs: z.number().int().nonnegative().optional(),
        functionCallId: CodemodeId,
        outcome: CodemodeOutcome,
        path: CodemodePath,
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
    "events.iterate.com/codemode/tool-provider-registered",
    "events.iterate.com/codemode/script-execution-requested",
    "events.iterate.com/codemode/script-execution-completed",
    "events.iterate.com/codemode/function-call-requested",
    "events.iterate.com/codemode/function-call-completed",
    "events.iterate.com/codemode/log-emitted",
  ],
  emits: [
    ...standardProcessorBehavior.emits,
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
              functionCallId: event.payload.functionCallId,
              input: event.payload.input,
              path: event.payload.path,
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
              outcome: event.payload.outcome,
              path: event.payload.path,
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
