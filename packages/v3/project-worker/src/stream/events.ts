// stream/events.ts — the stream event envelope (plain types) + idempotency rules. Zod-FREE on
// purpose: this module is on the edge/DO script's graph, so it carries no runtime validator (the
// zod contract helper `defineProcessorContract` lives on the SDK side, sdk/processor-contract.ts).
// The envelope itself is two plain types the append door checks by hand.

import { jsonEqual } from "../lib/patch.ts";
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

// The contract helper `defineProcessorContract` (the zod-based authoring surface) lives on the SDK
// side now — sdk/processor-contract.ts — so this module and the edge/DO script it belongs to stay
// zod-free. The platform's own contract is hand-built in stream/core-processor.ts.
