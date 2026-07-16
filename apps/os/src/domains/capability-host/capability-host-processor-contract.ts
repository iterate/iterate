import { z } from "zod";
import { ItxExpressionStep } from "../../itx/expression.ts";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import {
  CoreProcessorContract,
  STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
} from "../streams/core-processor-contract.ts";
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

const CapabilityHostBirthCertificate = z.strictObject({
  config: z.strictObject({
    /** The one scope this host inherits from; null explicitly terminates the chain. */
    ancestorPath: z.string().trim().min(1).nullable(),
  }),
});

/**
 * How stale a script-execution-requested's intent may be before the
 * reconciler settles it as expired instead of running it. Recovery can
 * deliver the request arbitrarily late; a host revived days later must not
 * run days-old scripts (only-settle-past-expiry).
 */
export const DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS = 15 * 60_000;

export const CapabilityHostProcessorContract = defineProcessorContract({
  slug: "capability-host",
  version: "0.2.0",
  description: "A tiny dynamic capability table and script execution journal.",
  // Brings the core `stream/*` lifecycle events into scope so the obligation
  // reconcile can consume `stream/woken` / `subscriber-connected` as re-check
  // signals (see `consumes`).
  processorDeps: [CoreProcessorContract],
  stateSchema: z.object({
    birthCertificate: CapabilityHostBirthCertificate.nullable().default(null),
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
    "events.iterate.com/capability-host/created": {
      description:
        "Creates a capability-host processor and declares its one explicit ancestor. Paths are addresses, not an implicit inheritance chain.",
      payloadSchema: CapabilityHostBirthCertificate,
      examples: [
        {
          description: "A top-level agent inherits project-scoped mounts directly from root.",
          payload: { config: { ancestorPath: "/" } },
        },
        {
          description: "The project root explicitly terminates capability inheritance.",
          payload: { config: { ancestorPath: null } },
        },
      ],
    },
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
      description:
        "A script should run in this capability scope. Before any attempt starts, the code is typechecked against the scope's capability types: a script with a PROVABLE error — a syntax error, or a near-miss typo where the compiler names the fix (\"Did you mean 'get'?\") — settles straight to an error completion carrying the compiler errors, without ever running (no started event). Everything less certain runs: capabilities are provided dynamically and declared types can lag the runtime, so bare property/argument mismatches, unknown/untyped capabilities, non-async block shapes, and checker failures all let the script run unchecked.",
      payloadSchema: z.looseObject({
        code: z.string(),
        executionId: z.string(),
        /** Epoch ms past which the reconciler settles instead of running. */
        expiresAt: z.number().int().positive(),
      }),
      examples: [
        {
          description: "An agent codemode turn asks the scope to run a script.",
          payload: {
            code: 'async (itx) => {\n  await itx.chat.sendMessage("Checking your email now...");\n}',
            executionId: "d0f7f2a4-9c1b-4e0e-8f3a-2b7c6d5e4a31",
            expiresAt: 1783012500000,
          },
        },
      ],
    },
    "events.iterate.com/capability-host/script-execution-started": {
      description:
        "An attempt to run the script began. Appended BEFORE the script body executes, so requested-without-started provably never ran (safe to start late) while started-without-completed died mid-run (settled as failure, never re-run).",
      payloadSchema: z.looseObject({ executionId: z.string() }),
      examples: [
        {
          description: "The scope began executing the requested script.",
          payload: { executionId: "d0f7f2a4-9c1b-4e0e-8f3a-2b7c6d5e4a31" },
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
            error: "TypeError: itx.integrations.gmail.get(...).listMessages is not a function",
            executionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
          },
        },
      ],
    },
  },
  consumes: [
    "events.iterate.com/capability-host/created",
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/capability-host/capability-revoked",
    "events.iterate.com/capability-host/script-execution-requested",
    "events.iterate.com/capability-host/script-execution-started",
    "events.iterate.com/capability-host/script-execution-completed",
    // Core lifecycle RE-CHECK signals (see the agent contract for the full
    // rationale): neither folds into state, but their at-head delivery gives
    // the script-obligation reconcile a guaranteed consumed-at-head turn —
    // `stream/woken` on a stream (re)start, `subscriber-connected` on a runner
    // (re)attach.
    "events.iterate.com/stream/woken",
    "events.iterate.com/stream/subscriber-connected",
    // The platform revival fact (core-owned, ONE type for every recovery-wired
    // processor; the payload's processorSlug names which). MUST be consumed
    // (the runner throws at construction otherwise): its ordinary delivery is
    // the guaranteed at-head turn where the obligation reconcile
    // (`processEvent` under `delivery.caughtUp`) re-drives open script
    // obligations — fresh requested scripts start, orphaned started scripts
    // settle as failures. Reduce ignores it, and it is absent from `emits`:
    // the recovery adapter appends it raw, as the runtime speaking.
    STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  ],
  emits: [
    "events.iterate.com/capability-host/created",
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
 * `ConsumedEvent<CapabilityHostProcessorContract>`.
 */
export type CapabilityHostProcessorContract = typeof CapabilityHostProcessorContract;
