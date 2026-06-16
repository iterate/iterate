// itx-contract.ts — the itx capability layer, defined as a durable event log.
//
// This is the whole of Step 8's idea in one place: an itx context is not a
// registry you mutate, it's a STREAM of events you fold. So we don't write a
// `Map`; we write the event *schemas* and a reducer, and let the real
// platform StreamProcessor do the folding, checkpointing, and
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
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";

/** A sturdy capability address — plain data; `dial` turns it back into a callable. */
export const CapabilityAddress = z.looseObject({ type: z.string() });

/** One row of the capability table — a folded provide, a built-in, anything that
 * describes a capability. Keyed in the fold's list by `path.join(".")`. */
export const CapabilityRecord = z.object({
  path: z.array(z.string()),
  kind: z.enum(["live", "rpc"]),
  address: CapabilityAddress.nullable().default(null),
  // Every capability is provided with `instructions` (what it's for, for an agent
  // or a human reading the table) and optional `types` (a type surface we carry
  // but don't yet do anything with).
  instructions: z.string().nullable().default(null),
  types: z.string().nullable().default(null),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecord>;

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
  // Map cannot be the reduced state). `capabilities` is a LIST of provided
  // capabilities in arrival order; a provide at a path already present REPLACES
  // that entry (never appends a duplicate). The table is derived, never the source.
  stateSchema: z.object({
    capabilities: z.array(CapabilityRecord).default([]),
    context: z
      .object({
        name: z.string().nullable().default(null),
        parent: ParentRef.nullable().default(null),
      })
      .nullable()
      .default(null),
  }),
  initialState: { capabilities: [], context: null },
  events: {
    "events.iterate.com/itx/context-created": {
      description:
        "The context's birth certificate, appended by its creator: naming + parentage. The fold takes the first one and ignores any later one (create is get-or-create).",
      payloadSchema: z.looseObject({
        name: z.string().nullable().optional(),
        parent: ParentRef.nullable().optional(),
      }),
    },
    "events.iterate.com/itx/capability-provided": {
      description:
        "A capability was provided at a path. THE write: the fold projects it into the capability table. A live provide appends this too (kind: live, address: null) while its stub stays an in-memory bridge entry.",
      payloadSchema: z.looseObject({
        path: z.array(z.string()),
        kind: z.enum(["live", "rpc"]),
        address: CapabilityAddress.nullable().optional(),
        instructions: z.string().optional(),
        types: z.string().optional(),
      }),
    },
    "events.iterate.com/itx/capability-revoked": {
      description:
        "A capability entry was removed (exact path match, never prefix). Also how a live cap goes away — there's no separate 'disconnected' event; you revoke it.",
      payloadSchema: z.looseObject({ path: z.array(z.string()) }),
    },
    // Codemode (Step 12). These are durable RECORDS, not state changes — the
    // fold doesn't consume them; together they bracket a script run. Declared
    // here so they're known events on the contract-validated stream, not strays.
    "events.iterate.com/itx/script-execution-requested": {
      description: "A script run was requested: `code` is the `async (itx) => …` program.",
      payloadSchema: z.looseObject({ executionId: z.string(), code: z.string().optional() }),
    },
    "events.iterate.com/itx/script-execution-completed": {
      description: "A script run settled. With the requested event, this is the durable record.",
      payloadSchema: z.looseObject({ executionId: z.string() }),
    },
  },
  consumes: [
    "events.iterate.com/itx/context-created",
    "events.iterate.com/itx/capability-provided",
    "events.iterate.com/itx/capability-revoked",
  ],
  emits: [
    "events.iterate.com/itx/context-created",
    "events.iterate.com/itx/capability-provided",
    "events.iterate.com/itx/capability-revoked",
    "events.iterate.com/itx/script-execution-requested",
    "events.iterate.com/itx/script-execution-completed",
  ],
});

export type ItxState = z.infer<(typeof ItxContract)["stateSchema"]>;
