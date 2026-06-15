// itx-contract.ts — the itx capability layer, defined as a durable event log.
//
// This is the whole of Step 8's idea in one place: an itx context is not a
// registry you mutate, it's a STREAM of events you fold. So we don't write a
// `Map`; we write the event *schemas* and a reducer, and let the real
// `@iterate-com/streams` StreamProcessor do the folding, checkpointing, and
// replay. `defineProcessorContract` is the same helper every other processor in
// the platform uses — the workshop depends on the real package, it doesn't
// reimplement it.
//
// A capability is one of two kinds: a live **stub** (held in memory, dies with
// its provider — NOT durable) or a sturdy **address** (plain serializable data
// describing how to re-make it). Only the address is durable, so the fold keeps
// the address and a live entry folds with `address: null`; the live stub itself
// lives in an in-memory bridge beside the fold (see itx-processor.ts).

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";

/** A sturdy capability address — plain data; `dial` turns it back into a callable. */
export const CapabilityAddress = z.looseObject({ type: z.string() });

/** The itx event types. The `events.iterate.com/itx/*` naming is the platform convention. */
export const ITX_EVENTS = {
  contextCreated: "events.iterate.com/itx/context-created",
  capabilityProvided: "events.iterate.com/itx/capability-provided",
  capabilityRevoked: "events.iterate.com/itx/capability-revoked",
  capabilityDisconnected: "events.iterate.com/itx/capability-disconnected",
} as const;

/** One folded row of the capability table. */
const CapabilityRecord = z.object({
  name: z.string(),
  kind: z.enum(["live", "rpc"]),
  address: CapabilityAddress.nullable().default(null),
  meta: z.record(z.string(), z.unknown()).default({}),
});

/** A parent context reference — the chain link the birth certificate records. */
const ParentRef = z.looseObject({
  ref: z.string(),
  address: CapabilityAddress.nullable().optional(),
});

export const ItxContract = defineProcessorContract({
  slug: "itx",
  version: "0.1.0",
  description: "A context: its capability table, folded from its own durable event log.",
  // State is a PLAIN OBJECT (the StreamProcessor checkpoints + validates it; a
  // Map cannot be the reduced state). The table is derived, never the source.
  stateSchema: z.object({
    capabilities: z.record(z.string(), CapabilityRecord).default({}),
    context: z
      .object({
        name: z.string().nullable().default(null),
        parent: ParentRef.nullable().default(null),
      })
      .nullable()
      .default(null),
  }),
  initialState: { capabilities: {}, context: null },
  events: {
    [ITX_EVENTS.contextCreated]: {
      description:
        "The context's birth certificate, appended by its creator: naming + parentage. The fold takes the first one and ignores any later one (create is get-or-create).",
      payloadSchema: z.looseObject({
        name: z.string().nullable().optional(),
        parent: ParentRef.nullable().optional(),
      }),
    },
    [ITX_EVENTS.capabilityProvided]: {
      description:
        "A capability was provided at a path. THE write: the fold projects it into the capability table. A live provide appends this too (kind: live, address: null) while its stub stays an in-memory bridge entry.",
      payloadSchema: z.looseObject({
        path: z.array(z.string()),
        kind: z.enum(["live", "rpc"]),
        address: CapabilityAddress.nullable().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    [ITX_EVENTS.capabilityRevoked]: {
      description: "A capability entry was removed (exact path match, never prefix).",
      payloadSchema: z.looseObject({ path: z.array(z.string()) }),
    },
    [ITX_EVENTS.capabilityDisconnected]: {
      description:
        "A live capability's provider session broke. Record only: the entry survives (describe() reports it offline) until revoked or re-provided.",
      payloadSchema: z.looseObject({ path: z.array(z.string()) }),
    },
  },
  consumes: [
    ITX_EVENTS.contextCreated,
    ITX_EVENTS.capabilityProvided,
    ITX_EVENTS.capabilityRevoked,
  ],
  emits: [
    ITX_EVENTS.contextCreated,
    ITX_EVENTS.capabilityProvided,
    ITX_EVENTS.capabilityRevoked,
    ITX_EVENTS.capabilityDisconnected,
  ],
});

export type ItxState = z.infer<(typeof ItxContract)["stateSchema"]>;
