import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "../stream-processor.ts";
import { ToolProviderDescriptor } from "../../codemode/types.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

const CodemodeEventOffset = z.number().int().positive();
const CodemodeProviderPath = z.array(z.string().min(1)).min(1);
const CodemodeToolFunctionPath = z.array(z.string().min(1));
const CodemodeSerializedError = z.unknown();

export const CodemodeProcessorContract = defineProcessorContract({
  slug: "codemode",
  version: "0.2.0",
  description:
    "Runs project-scoped codemode scripts from durable stream events and records execution telemetry.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    toolProviders: z.record(z.string(), ToolProviderDescriptor).default({}),
    scriptExecutions: z
      .record(
        z.string(),
        z.discriminatedUnion("status", [
          z.object({
            status: z.literal("in-flight"),
            code: z.string(),
            requestedOffset: CodemodeEventOffset,
          }),
          z.object({
            status: z.literal("finished"),
            code: z.string(),
            requestedOffset: CodemodeEventOffset,
            result: z.unknown(),
            error: CodemodeSerializedError.optional(),
            durationMs: z.number().int().nonnegative().optional(),
          }),
        ]),
      )
      .default({}),
    toolFunctionCalls: z
      .record(
        z.string(),
        z.discriminatedUnion("status", [
          z.object({
            status: z.literal("in-flight"),
            requestedOffset: CodemodeEventOffset,
            path: CodemodeProviderPath,
            payload: z.unknown(),
            providerPath: CodemodeProviderPath.optional(),
            toolFunctionPath: CodemodeToolFunctionPath.optional(),
            scriptExecutionRequestedOffset: CodemodeEventOffset.optional(),
          }),
          z.object({
            status: z.literal("succeeded"),
            requestedOffset: CodemodeEventOffset,
            result: z.unknown(),
            scriptExecutionRequestedOffset: CodemodeEventOffset.optional(),
          }),
          z.object({
            status: z.literal("failed"),
            requestedOffset: CodemodeEventOffset,
            error: CodemodeSerializedError,
            scriptExecutionRequestedOffset: CodemodeEventOffset.optional(),
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
      description: "A callable tool provider is available to future codemode scripts.",
      payloadSchema: z.object({
        descriptor: ToolProviderDescriptor,
        path: CodemodeProviderPath,
      }),
    },
    "events.iterate.com/codemode/tool-provider-described": {
      description: "A tool provider's generated TypeScript surface was loaded.",
      payloadSchema: z.object({
        path: CodemodeProviderPath,
        typeDefinitions: z.string(),
      }),
    },
    "events.iterate.com/codemode/script-execution-requested": {
      description: "A codemode script should run against the stream's registered providers.",
      payloadSchema: z.object({
        code: z.string().min(1),
      }),
    },
    "events.iterate.com/codemode/log-emitted": {
      description: "A codemode script emitted a console log line.",
      payloadSchema: z.object({
        level: z.enum(["log", "warn", "error"]),
        message: z.string(),
        scriptExecutionRequestedOffset: CodemodeEventOffset.optional(),
      }),
    },
    "events.iterate.com/codemode/tool-function-call-requested": {
      description: "A codemode script requested a provider tool function call.",
      payloadSchema: z.object({
        path: CodemodeProviderPath,
        payload: z.unknown(),
        providerPath: CodemodeProviderPath.optional(),
        toolFunctionPath: CodemodeToolFunctionPath.optional(),
        scriptExecutionRequestedOffset: CodemodeEventOffset.optional(),
      }),
    },
    "events.iterate.com/codemode/tool-function-call-succeeded": {
      description: "A provider tool function call returned successfully.",
      payloadSchema: z.object({
        result: z.unknown(),
        toolFunctionCallRequestedOffset: CodemodeEventOffset,
        scriptExecutionRequestedOffset: CodemodeEventOffset.optional(),
      }),
    },
    "events.iterate.com/codemode/tool-function-call-failed": {
      description: "A provider tool function call failed.",
      payloadSchema: z.object({
        error: CodemodeSerializedError,
        toolFunctionCallRequestedOffset: CodemodeEventOffset,
        scriptExecutionRequestedOffset: CodemodeEventOffset.optional(),
      }),
    },
    "events.iterate.com/codemode/script-execution-finished": {
      description: "A codemode script completed with either a result or a serialized error.",
      payloadSchema: z.object({
        result: z.unknown(),
        error: CodemodeSerializedError.optional(),
        durationMs: z.number().int().nonnegative().optional(),
        scriptExecutionRequestedOffset: CodemodeEventOffset,
      }),
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    "events.iterate.com/codemode/tool-provider-registered",
    "events.iterate.com/codemode/tool-provider-described",
    "events.iterate.com/codemode/script-execution-requested",
    "events.iterate.com/codemode/log-emitted",
    "events.iterate.com/codemode/tool-function-call-requested",
    "events.iterate.com/codemode/tool-function-call-succeeded",
    "events.iterate.com/codemode/tool-function-call-failed",
    "events.iterate.com/codemode/script-execution-finished",
  ],
  emits: [
    ...standardProcessorBehavior.emits,
    "events.iterate.com/codemode/tool-provider-described",
    "events.iterate.com/codemode/script-execution-requested",
    "events.iterate.com/codemode/log-emitted",
    "events.iterate.com/codemode/tool-function-call-requested",
    "events.iterate.com/codemode/tool-function-call-succeeded",
    "events.iterate.com/codemode/tool-function-call-failed",
    "events.iterate.com/codemode/script-execution-finished",
  ],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({
      state,
      event,
      contract,
    });

    switch (event.type) {
      case CoreProcessorRegisteredEventType:
      case "events.iterate.com/codemode/log-emitted":
      case "events.iterate.com/codemode/tool-provider-described":
        return nextState;
      case "events.iterate.com/codemode/tool-provider-registered":
        return {
          ...nextState,
          toolProviders: {
            ...nextState.toolProviders,
            [toolProviderRegistryKey(event.payload.path)]: event.payload.descriptor,
          },
        };
      case "events.iterate.com/codemode/script-execution-requested":
        return {
          ...nextState,
          scriptExecutions: {
            ...nextState.scriptExecutions,
            [String(event.offset)]: {
              status: "in-flight" as const,
              code: event.payload.code,
              requestedOffset: event.offset,
            },
          },
        };
      case "events.iterate.com/codemode/script-execution-finished": {
        const existing =
          nextState.scriptExecutions[String(event.payload.scriptExecutionRequestedOffset)];
        return {
          ...nextState,
          scriptExecutions: {
            ...nextState.scriptExecutions,
            [String(event.payload.scriptExecutionRequestedOffset)]: {
              status: "finished" as const,
              code: existing?.code ?? "",
              requestedOffset: event.payload.scriptExecutionRequestedOffset,
              result: event.payload.result,
              ...(event.payload.error == null ? {} : { error: event.payload.error }),
              ...(event.payload.durationMs == null ? {} : { durationMs: event.payload.durationMs }),
            },
          },
        };
      }
      case "events.iterate.com/codemode/tool-function-call-requested":
        return {
          ...nextState,
          toolFunctionCalls: {
            ...nextState.toolFunctionCalls,
            [String(event.offset)]: {
              status: "in-flight" as const,
              requestedOffset: event.offset,
              path: event.payload.path,
              payload: event.payload.payload,
              ...(event.payload.providerPath == null
                ? {}
                : { providerPath: event.payload.providerPath }),
              ...(event.payload.toolFunctionPath == null
                ? {}
                : { toolFunctionPath: event.payload.toolFunctionPath }),
              ...(event.payload.scriptExecutionRequestedOffset == null
                ? {}
                : {
                    scriptExecutionRequestedOffset: event.payload.scriptExecutionRequestedOffset,
                  }),
            },
          },
        };
      case "events.iterate.com/codemode/tool-function-call-succeeded":
        return {
          ...nextState,
          toolFunctionCalls: {
            ...nextState.toolFunctionCalls,
            [String(event.payload.toolFunctionCallRequestedOffset)]: {
              status: "succeeded" as const,
              requestedOffset: event.payload.toolFunctionCallRequestedOffset,
              result: event.payload.result,
              ...(event.payload.scriptExecutionRequestedOffset == null
                ? {}
                : {
                    scriptExecutionRequestedOffset: event.payload.scriptExecutionRequestedOffset,
                  }),
            },
          },
        };
      case "events.iterate.com/codemode/tool-function-call-failed":
        return {
          ...nextState,
          toolFunctionCalls: {
            ...nextState.toolFunctionCalls,
            [String(event.payload.toolFunctionCallRequestedOffset)]: {
              status: "failed" as const,
              requestedOffset: event.payload.toolFunctionCallRequestedOffset,
              error: event.payload.error,
              ...(event.payload.scriptExecutionRequestedOffset == null
                ? {}
                : {
                    scriptExecutionRequestedOffset: event.payload.scriptExecutionRequestedOffset,
                  }),
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
