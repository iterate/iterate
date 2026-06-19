import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { DynamicWorkerRef } from "../domains/dynamic-workers/dynamic-worker-ref.ts";

export const CapabilityAddress = DynamicWorkerRef;
export type CapabilityAddress = z.infer<typeof CapabilityAddress>;

export const CapabilityRecord = z.object({
  address: CapabilityAddress.nullable().default(null),
  path: z.array(z.string()),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecord>;

export const ItxContract = defineProcessorContract({
  slug: "itx-v2",
  version: "0.1.0",
  description: "A tiny dynamic capability table and script execution journal.",
  stateSchema: z.object({
    capabilities: z.array(CapabilityRecord).default([]),
    pendingScriptExecutions: z.record(z.string(), z.boolean()).default({}),
  }),
  initialState: { capabilities: [], pendingScriptExecutions: {} },
  events: {
    "events.iterate.com/itx/capability-provided": {
      description: "A dynamic capability was mounted at a path.",
      payloadSchema: z.looseObject({
        address: CapabilityAddress.nullable().optional(),
        path: z.array(z.string()),
      }),
    },
    "events.iterate.com/itx/capability-revoked": {
      description: "A dynamic capability was removed.",
      payloadSchema: z.looseObject({ path: z.array(z.string()) }),
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
