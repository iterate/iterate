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

/**
 * How stale a script-execution-requested's intent may be before the
 * reconciler settles it as expired instead of running it. Recovery can
 * deliver the request arbitrarily late; a host revived days later must not
 * run days-old scripts (only-settle-past-expiry).
 */
export const DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS = 15 * 60_000;

export const CapabilityHostProcessorContract = defineProcessorContract({
  slug: "capability-host",
  version: "0.1.0",
  description: "A tiny dynamic capability table and script execution journal.",
  stateSchema: z.object({
    capabilities: z.array(CapabilityRecord).default([]),
    /**
     * The host's open script OBLIGATIONS, keyed by executionId — the "what
     * should be running" half of the end-of-batch reconciliation (the same
     * shape as the LLM providers' `requests`). Entries carry the code so an
     * attempt can start from state alone; terminal completions delete them.
     * `started` without a live execution means the running incarnation died —
     * settled as a failure, never re-run (scripts are not assumed idempotent).
     */
    scriptExecutions: z
      .record(
        z.string(),
        z.object({
          status: z.enum(["requested", "started"]),
          code: z.string(),
          /** Epoch ms past which no attempt may START (only-settle-past-expiry). */
          expiresAt: z.number().int().positive(),
        }),
      )
      .default({}),
  }),
  events: {
    "events.iterate.com/capability-host/capability-provided": {
      description: "A capability was mounted at a path.",
      payloadSchema: CapabilityProvidedPayload,
    },
    "events.iterate.com/capability-host/capability-revoked": {
      description: "A dynamic capability was removed.",
      payloadSchema: CapabilityRevokedPayload,
    },
    "events.iterate.com/capability-host/script-execution-requested": {
      description: "A script should run in this capability scope.",
      payloadSchema: z.looseObject({
        code: z.string(),
        executionId: z.string(),
        /** Epoch ms past which the reconciler settles instead of running.
         * Absent (raw appends), defaults to createdAt + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS. */
        expiresAt: z.number().int().positive().optional(),
      }),
    },
    "events.iterate.com/capability-host/script-execution-started": {
      description:
        "An attempt to run the script began. Appended BEFORE the script body executes, so requested-without-started provably never ran (safe to start late) while started-without-completed died mid-run (settled as failure, never re-run).",
      payloadSchema: z.looseObject({ executionId: z.string() }),
    },
    "events.iterate.com/capability-host/script-execution-completed": {
      description: "A script finished running in this capability scope.",
      payloadSchema: z.looseObject({
        error: z.string().optional(),
        executionId: z.string(),
        result: z.unknown().optional(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/capability-host/capability-revoked",
    "events.iterate.com/capability-host/script-execution-requested",
    "events.iterate.com/capability-host/script-execution-started",
    "events.iterate.com/capability-host/script-execution-completed",
  ],
  emits: [
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/capability-host/capability-revoked",
    "events.iterate.com/capability-host/script-execution-requested",
    "events.iterate.com/capability-host/script-execution-started",
    "events.iterate.com/capability-host/script-execution-completed",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<CapabilityHostProcessorContract>`,
 * `ConsumedEvent<CapabilityHostProcessorContract>`, `ProcessorEvent<CapabilityHostProcessorContract, T>`.
 */
export type CapabilityHostProcessorContract = typeof CapabilityHostProcessorContract;
