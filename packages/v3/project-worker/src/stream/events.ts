// stream/events.ts — the stream event envelope + idempotency rules. Zod-FREE on purpose: this module
// is on the edge/DO script's graph, so it carries no runtime validator (sdk/processor-contract.ts
// has the zod half).

import { jsonEqual } from "../lib/patch.ts";
// THE one deep-equal lives in patch.ts; re-exported here for the SDK bundle.
export { jsonEqual };

/** What `append` accepts: the event body, before the stream assigns its committed identity. The
 *  door checks ONE rule by hand: `type` is a non-empty string. */
export type StreamEventInput = {
  /** Convention: `events.iterate.com/<domain>/<fact>`. */
  type: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Provenance: which processor (while processing what) appended this — stamped by the engine's
   *  `append` — and WHO: the session's verified principal (src/principal.ts), set by the DO's append
   *  root from the session's project token and never taken from a client. */
  source?: {
    processor?: {
      slug: string;
      version: string;
      whileProcessing?: { offset: number; type: string };
    };
    principal?: { actor: string; email?: string };
  };
  /** Same key + same body = dedupe (the existing event is returned); different body = loud error. */
  idempotencyKey?: string;
  /** OPTIONAL PRECONDITION (apps/os): land at exactly this offset or refuse the whole batch with
   *  OFFSET_CONFLICT — "nothing has happened since I last looked". Never stored in the body. */
  offset?: number;
  /** An EPHEMERAL event rides the stream to live subscribers but is NEVER persisted: it consumes an
   *  offset, triggers zero writes, and its body is gone the moment the incarnation ends — nobody can
   *  redeliver it (stream.ts, the zero-write contract). A durable OMITS the field. */
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
