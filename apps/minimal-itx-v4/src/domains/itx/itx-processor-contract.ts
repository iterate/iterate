import { z } from "zod";
import { defineProcessorContract } from "../streams/stream-processor.ts";
import { DynamicWorkerRef } from "../workers/schemas.ts";
import type {
  CapabilityProvidedPayload as CapabilityProvidedPayloadType,
  CapabilityRecord as CapabilityRecordType,
  RevokeCapabilityInput,
} from "../../types.ts";

const CapabilityMetadata = {
  instructions: z.string().optional(),
  types: z.string().optional(),
};

const OpenApiFields = {
  baseUrl: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  specUrl: z.string(),
};

const McpFields = {
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  url: z.string(),
};

const CapabilityProvidedPayload = z.discriminatedUnion("type", [
  z.strictObject({
    ...CapabilityMetadata,
    flattenNestedPath: z.boolean().optional(),
    path: z.array(z.string()),
    type: z.literal("live"),
  }),
  z.strictObject({
    ...CapabilityMetadata,
    flattenNestedPath: z.boolean().optional(),
    path: z.array(z.string()),
    ref: DynamicWorkerRef,
    type: z.literal("dynamic-worker"),
  }),
  z.strictObject({
    ...CapabilityMetadata,
    ...McpFields,
    path: z.array(z.string()),
    type: z.literal("mcp"),
  }),
  z.strictObject({
    ...CapabilityMetadata,
    ...OpenApiFields,
    path: z.array(z.string()),
    type: z.literal("openapi"),
  }),
]) satisfies z.ZodType<CapabilityProvidedPayloadType, unknown>;

const CapabilityRecord = z.discriminatedUnion("type", [
  z.strictObject({
    ...CapabilityMetadata,
    flattenNestedPath: z.boolean().optional(),
    path: z.array(z.string()),
    providedAtOffset: z.number().int().nonnegative(),
    type: z.literal("live"),
  }),
  z.strictObject({
    ...CapabilityMetadata,
    flattenNestedPath: z.boolean().optional(),
    path: z.array(z.string()),
    providedAtOffset: z.number().int().nonnegative(),
    ref: DynamicWorkerRef,
    type: z.literal("dynamic-worker"),
  }),
  z.strictObject({
    ...CapabilityMetadata,
    ...McpFields,
    path: z.array(z.string()),
    providedAtOffset: z.number().int().nonnegative(),
    type: z.literal("mcp"),
  }),
  z.strictObject({
    ...CapabilityMetadata,
    ...OpenApiFields,
    path: z.array(z.string()),
    providedAtOffset: z.number().int().nonnegative(),
    type: z.literal("openapi"),
  }),
]) satisfies z.ZodType<CapabilityRecordType, unknown>;

const CapabilityRevokedPayload = z.strictObject({
  path: z.array(z.string()),
  providedAtOffset: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<RevokeCapabilityInput, unknown>;

export const ItxProcessorContract = defineProcessorContract({
  slug: "itx-v2",
  version: "0.1.0",
  description: "A tiny dynamic capability table and script execution journal.",
  stateSchema: z.object({
    capabilities: z.array(CapabilityRecord).default([]),
    pendingScriptExecutions: z.record(z.string(), z.boolean()).default({}),
  }),
  events: {
    "events.iterate.com/itx/capability-provided": {
      description: "A capability was mounted at a path.",
      payloadSchema: CapabilityProvidedPayload,
    },
    "events.iterate.com/itx/capability-revoked": {
      description: "A dynamic capability was removed.",
      payloadSchema: CapabilityRevokedPayload,
    },
    "events.iterate.com/itx/script-execution-requested": {
      description: "A script should run in this ITX context.",
      payloadSchema: z.looseObject({ code: z.string(), executionId: z.string() }),
    },
    "events.iterate.com/itx/script-execution-completed": {
      description: "A script finished running in this ITX context.",
      payloadSchema: z.looseObject({
        error: z.string().optional(),
        executionId: z.string(),
        result: z.unknown().optional(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/itx/capability-provided",
    "events.iterate.com/itx/capability-revoked",
    "events.iterate.com/itx/script-execution-requested",
    "events.iterate.com/itx/script-execution-completed",
  ],
  emits: [
    "events.iterate.com/itx/capability-provided",
    "events.iterate.com/itx/capability-revoked",
    "events.iterate.com/itx/script-execution-requested",
    "events.iterate.com/itx/script-execution-completed",
  ],
});
