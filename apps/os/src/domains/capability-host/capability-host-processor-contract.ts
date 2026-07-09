import { z } from "zod";
import { ItxExpressionStep } from "../../itx/expression.ts";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import type {
  CapabilityProvidedPayload as CapabilityProvidedPayloadType,
  CapabilityRecord as CapabilityRecordType,
  RevokeCapabilityInput,
} from "./types.ts";

const CapabilityMetadata = {
  instructions: z.string().optional(),
  types: z.string().optional(),
};

const ItxExpressionFields = {
  expression: z.array(ItxExpressionStep),
  flattenNestedPaths: z.boolean().optional(),
};

const CapabilityProvidedPayload = z.discriminatedUnion("type", [
  z.strictObject({
    ...CapabilityMetadata,
    flattenNestedPaths: z.boolean().optional(),
    path: z.array(z.string()),
    type: z.literal("live"),
  }),
  z.strictObject({
    ...CapabilityMetadata,
    ...ItxExpressionFields,
    path: z.array(z.string()),
    type: z.literal("itx-expression"),
  }),
]) satisfies z.ZodType<CapabilityProvidedPayloadType, unknown>;

const CapabilityRecord = z.discriminatedUnion("type", [
  z.strictObject({
    ...CapabilityMetadata,
    flattenNestedPaths: z.boolean().optional(),
    path: z.array(z.string()),
    providedAtOffset: z.number().int().nonnegative(),
    type: z.literal("live"),
  }),
  z.strictObject({
    ...CapabilityMetadata,
    ...ItxExpressionFields,
    path: z.array(z.string()),
    providedAtOffset: z.number().int().nonnegative(),
    type: z.literal("itx-expression"),
  }),
]) satisfies z.ZodType<CapabilityRecordType, unknown>;

const CapabilityRevokedPayload = z.strictObject({
  path: z.array(z.string()),
  providedAtOffset: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<RevokeCapabilityInput, unknown>;

export const CapabilityHostProcessorContract = defineProcessorContract({
  slug: "capability-host",
  version: "0.1.0",
  description: "A tiny dynamic capability table and script execution journal.",
  stateSchema: z.object({
    capabilities: z.array(CapabilityRecord).default([]),
    pendingScriptExecutions: z.record(z.string(), z.boolean()).default({}),
  }),
  events: {
    "events.iterate.com/capability-host/capability-provided": {
      description: "A capability was mounted at a path.",
      payloadSchema: CapabilityProvidedPayload,
      examples: [
        {
          description:
            "A live capability object mounted at tools.weather; it lives only as long as the providing session.",
          payload: {
            instructions: "Call tools.weather.forecast({ city }) for a 3-day forecast.",
            path: ["tools", "weather"],
            type: "live",
          },
        },
        {
          description:
            "An OpenAPI connection persisted as an itx expression and mounted at pets; each use re-evaluates the expression.",
          payload: {
            expression: [
              "openapi",
              ["connect", { specUrl: "https://petstore.example.com/openapi.json" }],
            ],
            instructions: "The pet store API. List pets with pets.listPets().",
            path: ["pets"],
            type: "itx-expression",
            types:
              "export type Capability = { listPets(): Promise<{ id: number; name: string }[]> };",
          },
        },
      ],
    },
    "events.iterate.com/capability-host/capability-revoked": {
      description: "A dynamic capability was removed.",
      payloadSchema: CapabilityRevokedPayload,
      examples: [
        {
          description:
            "The current mount at pets is removed; pass providedAtOffset to revoke one exact mount instead.",
          payload: { path: ["pets"] },
        },
      ],
    },
    "events.iterate.com/capability-host/script-execution-requested": {
      description: "A script should run in this capability scope.",
      payloadSchema: z.looseObject({ code: z.string(), executionId: z.string() }),
      examples: [
        {
          description: "An agent codemode turn asks the scope to run a script.",
          payload: {
            code: 'async (itx) => {\n  await itx.chat.sendMessage("Checking your email now...");\n}',
            executionId: "d0f7f2a4-9c1b-4e0e-8f3a-2b7c6d5e4a31",
          },
        },
      ],
    },
    "events.iterate.com/capability-host/script-execution-completed": {
      description: "A script finished running in this capability scope.",
      payloadSchema: z.looseObject({
        error: z.string().optional(),
        executionId: z.string(),
        result: z.unknown().optional(),
      }),
      examples: [
        {
          description: "The script finished and returned a value.",
          payload: {
            executionId: "d0f7f2a4-9c1b-4e0e-8f3a-2b7c6d5e4a31",
            result: { unreadCount: 3 },
          },
        },
        {
          description: "The script threw; the error message is journaled.",
          payload: {
            error: "TypeError: itx.gmail.listMesages is not a function",
            executionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
          },
        },
      ],
    },
  },
  consumes: [
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/capability-host/capability-revoked",
    "events.iterate.com/capability-host/script-execution-requested",
    "events.iterate.com/capability-host/script-execution-completed",
  ],
  emits: [
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/capability-host/capability-revoked",
    "events.iterate.com/capability-host/script-execution-requested",
    "events.iterate.com/capability-host/script-execution-completed",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<CapabilityHostProcessorContract>`,
 * `ConsumedEvent<CapabilityHostProcessorContract>`, `ProcessorEvent<CapabilityHostProcessorContract, T>`.
 */
export type CapabilityHostProcessorContract = typeof CapabilityHostProcessorContract;
