// stream/events.ts — the stream event envelope (plain types) + idempotency rules + the zod contract
// helper. API mirrors apps/os (`packages/iterate/src/processors/schemas.ts` / `idempotency.ts`) so
// processors port both ways. zod is for CONTRACTS (state + owned-event payload schemas — built-ins
// and userspace alike); the envelope itself is two plain types the append door checks by hand.

import { z } from "zod";
import { jsonEqual } from "../lib/patch.ts";
import type { EventDefinition, ProcessorContract } from "./processor.ts";
// THE one deep-equal lives in patch.ts (the live-state diff needs it dependency-free); the
// idempotency-body compare below is the same test, re-exported here for the SDK bundle.
export { jsonEqual };

/** What `append` accepts: the event body, before the stream assigns its committed identity. Plain
 *  types — the door (stream.ts `append`, step 1) checks the two rules by hand: `type` is a non-empty
 *  string, and an ephemeral event carries no idempotencyKey. */
export type StreamEventInput = {
  /** Convention: `events.iterate.com/<domain>/<fact>`. */
  type: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Provenance: which processor (while processing what) appended this. Stamped by the engine's `append`. */
  source?: {
    processor?: {
      slug: string;
      version: string;
      whileProcessing?: { offset: number; type: string };
    };
  };
  /** Same key + same body = dedupe (the existing event is returned); different body = loud error. */
  idempotencyKey?: string;
  /** OPTIONAL PRECONDITION (apps/os): land at exactly this offset or refuse the whole batch with
   *  OFFSET_CONFLICT — "nothing has happened since I last looked". Never stored in the body. */
  offset?: number;
  /** An EPHEMERAL event rides the stream to live subscribers but is NEVER persisted: it consumes
   *  an offset (which survives as a valid gap), triggers zero reduce/cursor writes, and its body is
   *  gone the moment the incarnation ends — it cannot be redelivered by anyone. `ephemeral: false`
   *  is a loud input error, not a synonym for durable. */
  ephemeral?: true;
};

/** A committed event: the input plus the identity the stream assigned at its commit point. */
export type StreamEvent = Omit<StreamEventInput, "offset"> & {
  offset: number;
  createdAt: string;
  path: string;
};

// ── idempotency (apps/os semantics, message text kept greppable across RPC hops) ──

export function idempotencyConflictMessage(idempotencyKey: string, existingOffset: number): string {
  return `idempotency key "${idempotencyKey}" already names a different event at offset ${existingOffset}`;
}

/** Structural equality of the parts an idempotent retry must not change. */
export function sameIdempotentEvent(
  existingEvent: StreamEventInput,
  requestedEvent: StreamEventInput,
): boolean {
  return (
    existingEvent.type === requestedEvent.type &&
    jsonEqual(existingEvent.payload, requestedEvent.payload) &&
    jsonEqual(existingEvent.metadata, requestedEvent.metadata)
  );
}

// ── the zod contract helper (the host-side way to author a ProcessorContract) ──
// Userspace SDK contracts are plain object literals with `initialState`; built-ins get schema
// validation on top. Both produce the SAME ProcessorContract shape the base class consumes.

export function defineProcessorContract<StateSchema extends z.ZodType>(contract: {
  slug: string;
  version: string;
  description: string;
  /** Must parse `{}` — the initial state is `stateSchema.parse({})` (all fields defaulted). */
  stateSchema: StateSchema;
  events: Record<string, EventDefinition>;
  consumes: readonly string[];
  emits: readonly string[];
}): ProcessorContract<z.infer<StateSchema>> & {
  stateSchema: StateSchema;
  /** Build a typed input for an owned event (validates the payload against its schema). */
  buildEvent: (event: {
    type: string;
    payload?: unknown;
    idempotencyKey?: string;
  }) => StreamEventInput;
} {
  const initial = contract.stateSchema.safeParse({});
  if (!initial.success)
    throw new Error(`contract "${contract.slug}": stateSchema must parse {} (default every field)`);
  return {
    slug: contract.slug,
    version: contract.version,
    description: contract.description,
    consumes: contract.consumes,
    emits: contract.emits,
    stateSchema: contract.stateSchema,
    initialState: () => contract.stateSchema.parse({}) as z.infer<StateSchema>,
    buildEvent: (event) => {
      const def = contract.events[event.type];
      if (!def)
        throw new Error(
          `contract "${contract.slug}": buildEvent event type "${event.type}" is not owned`,
        );
      return {
        type: event.type,
        payload: def.payloadSchema.parse(event.payload ?? {}) as Record<string, unknown>,
        ...(event.idempotencyKey && { idempotencyKey: event.idempotencyKey }),
      };
    },
  };
}
