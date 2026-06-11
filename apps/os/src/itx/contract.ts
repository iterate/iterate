// The journal contract: the context's event vocabulary and the shape of its
// folded state (the repo's processor-contract convention — see
// docs/domain-objects-and-stream-processors.md). The context's journal is an
// ordinary event stream; these are its event types. Provides, revokes,
// disconnects, and the script execution record all live here — there is no
// other write. Payload schemas are deliberately LOOSE (z.looseObject +
// optionals): a journal may carry events from before a deploy's schema, and
// a malformed payload must be ignored by the fold (itx.ts
// reduceItxJournalEvent), never wedge ingestion.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";

export const ITX_EVENT_TYPES = {
  contextCreated: "events.iterate.com/itx/context-created",
  capabilityProvided: "events.iterate.com/itx/capability-provided",
  capabilityRevoked: "events.iterate.com/itx/capability-revoked",
  capabilityDisconnected: "events.iterate.com/itx/capability-disconnected",
  scriptExecutionRequested: "events.iterate.com/itx/script-execution-requested",
  scriptExecutionCompleted: "events.iterate.com/itx/script-execution-completed",
} as const;

const workerSourceEnvelope = {
  compatibilityDate: z.string().optional(),
  entrypoint: z.string().optional(),
  exportType: z.enum(["worker-entrypoint", "durable-object"]).optional(),
};

const WorkerSourceRecord = z.discriminatedUnion("type", [
  z.looseObject({
    ...workerSourceEnvelope,
    cacheKey: z.string(),
    mainModule: z.string(),
    modules: z.record(z.string(), z.string()),
    type: z.literal("inline"),
  }),
  z.looseObject({
    ...workerSourceEnvelope,
    bundle: z
      .looseObject({
        externals: z.array(z.string()).optional(),
        minify: z.boolean().optional(),
      })
      .optional(),
    commit: z.string(),
    path: z.string(),
    repo: z.string(),
    type: z.literal("repo"),
  }),
]);

const WorkerRefRecord = z.discriminatedUnion("type", [
  z.looseObject({ binding: z.string(), type: z.literal("binding") }),
  z.looseObject({ type: z.literal("loopback") }),
  z.looseObject({ binding: z.string(), name: z.string(), type: z.literal("durable-object") }),
  z.looseObject({ source: WorkerSourceRecord, type: z.literal("source") }),
]);

export const CapabilityAddressRecord = z.discriminatedUnion("type", [
  z.looseObject({
    entrypoint: z.string().optional(),
    props: z.record(z.string(), z.json()).optional(),
    type: z.literal("rpc"),
    worker: WorkerRefRecord,
  }),
  z.looseObject({
    headers: z.record(z.string(), z.string()).optional(),
    type: z.literal("url"),
    url: z.string(),
  }),
]);

const ParentRefRecord = z.object({
  address: CapabilityAddressRecord,
  id: z.string(),
});

const CapabilityRecord = z.object({
  address: CapabilityAddressRecord.nullable().default(null),
  kind: z.enum(["live", "rpc", "url"]),
  meta: z.record(z.string(), z.json()).default({}),
  name: z.string(),
  owner: z.string(),
  updatedAtMs: z.number().default(0),
});

/** The journal contract: the context's state is the fold of these events. */
export const ItxContract = defineProcessorContract({
  slug: "itx",
  version: "0.1.0",
  description:
    "A context: its birth certificate and capability table, folded from its journal stream.",
  stateSchema: z.object({
    capabilities: z.record(z.string(), CapabilityRecord).default({}),
    /** The birth certificate (journal event #1). null until created — and
     * forever null for code-created contexts like the project context, whose
     * identity derives from its host's name instead. */
    context: z
      .object({
        id: z.string(),
        name: z.string().nullable().default(null),
        parent: ParentRefRecord.nullable().default(null),
      })
      .nullable()
      .default(null),
    /** Enqueued script executions that have not completed — the
     * at-least-once dedupe for processor-mode runs. */
    pendingExecutions: z.record(z.string(), z.boolean()).default({}),
  }),
  initialState: { capabilities: {}, context: null, pendingExecutions: {} },
  events: {
    "events.iterate.com/itx/context-created": {
      description:
        "The context's birth certificate — the FIRST event in its journal. Carries identity and parentage; the fold takes the first one and ignores any later one (exactly-once is a property of the fold, not of delivery).",
      payloadSchema: z.looseObject({
        id: z.string(),
        name: z.string().nullable().optional(),
        parent: ParentRefRecord.nullable().optional(),
      }),
    },
    "events.iterate.com/itx/capability-provided": {
      description:
        "A capability was provided at a path. THE write: the fold projects it into the capability table. Live provides journal this record too (it outlives the session) while the stub stays an in-memory instance field.",
      payloadSchema: z.looseObject({
        address: CapabilityAddressRecord.nullable().optional(),
        kind: z.string().optional(),
        meta: z.record(z.string(), z.json()).optional(),
        owner: z.string().optional(),
        path: z.array(z.string()).optional(),
        providedAtMs: z.number().optional(),
      }),
    },
    "events.iterate.com/itx/capability-revoked": {
      description: "A capability entry was removed (exact path match, never prefix).",
      payloadSchema: z.looseObject({ path: z.array(z.string()).optional() }),
    },
    "events.iterate.com/itx/capability-disconnected": {
      description:
        "A live capability's provider session broke. Record only: the provided entry survives (describe() reports it offline) until revoked or re-provided.",
      payloadSchema: z.looseObject({ path: z.array(z.string()).optional() }),
    },
    "events.iterate.com/itx/script-execution-requested": {
      description:
        "A script execution was requested: `code` is the one script shape, `async (itx) => …`. With `enqueued: true`, appending IS requesting work — the context's processor runs it and appends the completed event; without it the event is the record of a synchronous run (the /api/itx/run door).",
      payloadSchema: z.looseObject({
        code: z.string().optional(),
        context: z.string().optional(),
        enqueued: z.boolean().optional(),
        executionId: z.string(),
      }),
    },
    "events.iterate.com/itx/script-execution-completed": {
      description:
        "A script execution settled. Together with the requested event this is the durable record; everything between them is invisible to the stream.",
      payloadSchema: z.looseObject({ executionId: z.string() }),
    },
  },
  consumes: [
    "events.iterate.com/itx/context-created",
    "events.iterate.com/itx/capability-provided",
    "events.iterate.com/itx/capability-revoked",
    "events.iterate.com/itx/script-execution-requested",
    "events.iterate.com/itx/script-execution-completed",
  ],
  emits: [
    "events.iterate.com/itx/context-created",
    "events.iterate.com/itx/capability-provided",
    "events.iterate.com/itx/capability-revoked",
    "events.iterate.com/itx/capability-disconnected",
    "events.iterate.com/itx/script-execution-requested",
    "events.iterate.com/itx/script-execution-completed",
  ],
});

export type ItxState = z.infer<(typeof ItxContract)["stateSchema"]>;
