// contract.ts — an itx context, defined as a durable event log.
//
// The central idea: an itx context is NOT a registry you mutate. It is a STREAM
// of events you fold. So this file does not define a `Map`; it defines the event
// SCHEMAS and lets the real platform StreamProcessor do the folding,
// checkpointing and replay. `defineProcessorContract` is the same helper every
// other processor in the platform uses — we depend on the real package, we do
// not reimplement it.
//
// A capability is one of two kinds, and the kind is NOT stored — it is derived:
//
//   • a LIVE stub      — a callable held in memory, dies with its provider.
//                        NOT durable, so the fold records it with `address: null`
//                        and the actual stub lives in an in-memory bridge beside
//                        the fold (see itx.ts).
//   • a STURDY address — plain serializable data describing how to re-make the
//                        capability (`dial` turns it back into a callable). This
//                        IS durable, so the fold stores the address itself.
//
// `address === null` ⟺ live; `address !== null` ⟺ sturdy. One field, one
// discriminator — there is no separate `kind` column to keep in sync.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";

/** A sturdy capability address — plain data; `dial` (server.ts) turns it back
 *  into a callable. `type` selects the dialer; the rest is dialer-specific. */
export const CapabilityAddress = z.looseObject({ type: z.string() });
export type CapabilityAddress = z.infer<typeof CapabilityAddress>;

/** One row of the capability table: the path it is mounted at, its address
 *  (null ⟺ live), and the metadata it was provided with. This same shape
 *  describes a folded provide, a built-in, and a parent's capability — there is
 *  one capability-descriptor type, everywhere. */
export const CapabilityRecord = z.object({
  path: z.array(z.string()),
  // null ⟺ a live stub (in the in-memory bridge); non-null ⟺ a sturdy address.
  address: CapabilityAddress.nullable().default(null),
  // What the capability is for — for an agent or a human reading the table.
  instructions: z.string().nullable().default(null),
  // An optional type surface we carry but do not yet act on.
  types: z.string().nullable().default(null),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecord>;

const ScriptExecutionRecord = z.object({
  executionId: z.string(),
  code: z.string().nullable().default(null),
  status: z.enum(["requested", "completed"]).default("requested"),
  result: z.unknown().optional(),
  error: z.string().nullable().default(null),
});
export type ScriptExecutionRecord = z.infer<typeof ScriptExecutionRecord>;

export const ItxContract = defineProcessorContract({
  slug: "itx",
  version: "0.1.0",
  description: "A context: its capability table, folded from its own durable event log.",
  // State is a PLAIN OBJECT (the StreamProcessor checkpoints + validates it; a
  // Map cannot be the reduced state). `capabilities` is a LIST in arrival order;
  // a provide at a path already present REPLACES that entry. The table is
  // derived from the log, never the source of truth.
  //
  // There is no `context`/parentage field here: host topology appears as the
  // reserved `parent` built-in capability, not as folded state. Nothing reads a
  // folded parentage copy, so it does not exist.
  stateSchema: z.object({
    capabilities: z.array(CapabilityRecord).default([]),
    scriptExecutions: z.array(ScriptExecutionRecord).default([]),
  }),
  initialState: { capabilities: [], scriptExecutions: [] },
  events: {
    "events.iterate.com/itx/capability-provided": {
      description:
        "A capability was provided at a path. THE write: the fold projects it into the table. A live provide records `address: null` (its stub stays an in-memory bridge entry); a sturdy provide records the address.",
      payloadSchema: z.looseObject({
        path: z.array(z.string()),
        address: CapabilityAddress.nullable().optional(),
        instructions: z.string().optional(),
        types: z.string().optional(),
      }),
    },
    "events.iterate.com/itx/capability-revoked": {
      description:
        "A capability entry was removed (exact path match, never prefix). Also how a live cap goes away — there is no separate 'disconnected' event; you revoke it.",
      payloadSchema: z.looseObject({ path: z.array(z.string()) }),
    },
    // Codemode. These are durable RECORDS, not state changes — the fold does not
    // consume them; together they bracket a script run. Declared here so they are
    // known events on the contract-validated stream, not strays. They demonstrate
    // that a log holds both state-changing events AND plain audit records.
    "events.iterate.com/itx/script-execution-requested": {
      description: "A codemode run was requested: `code` is the `async (itx) => …` program.",
      payloadSchema: z.looseObject({ executionId: z.string(), code: z.string().optional() }),
    },
    "events.iterate.com/itx/script-execution-completed": {
      description: "A codemode run settled. With the requested event, this is the durable record.",
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

export type ItxState = z.infer<(typeof ItxContract)["stateSchema"]>;
