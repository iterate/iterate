// core/events.ts — the stream event envelope + idempotency rules. API mirrors apps/os
// (`packages/iterate/src/processors/schemas.ts` / `idempotency.ts`) so processors port both ways;
// the clean room deliberately omits the pieces it doesn't have yet (ephemeral events, copiedFrom
// subscription-copy provenance) rather than carrying dead schema.

import { z } from "zod";

/** ONE non-resetting depth budget for every recursive JSON walk in this package (parser values,
 *  substitution, hole scans, `jsonEqual`). Cycles are impossible (everything is parsed JSON, no
 *  custom serializers), so the only exposure is stack exhaustion from deeply-nested-but-acyclic
 *  input — and per the receiver-side-limits rule the budget must never reset at argument
 *  boundaries. 64 is far beyond any honest expression. */
export const MAX_VALUE_DEPTH = 64;
export function deeper(depth: number, what: string): number {
  if (depth >= MAX_VALUE_DEPTH)
    throw new Error(`${what}: value nesting exceeds ${MAX_VALUE_DEPTH} levels`);
  return depth + 1;
}

/** What `append` accepts: the event body, before the stream assigns its committed identity. */
export const StreamEventInput = z.strictObject({
  /** Convention: `events.iterate.com/<domain>/<fact>`. */
  type: z.string().trim().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Provenance: which processor (while processing what) appended this. Stamped by the runner. */
  source: z
    .strictObject({
      processor: z
        .strictObject({
          slug: z.string(),
          version: z.string(),
          whileProcessing: z
            .strictObject({
              offset: z.number().int().nonnegative(),
              type: z.string().trim().min(1),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
  /** Same key + same body = dedupe (the existing event is returned); different body = loud error. */
  idempotencyKey: z.string().trim().min(1).optional(),
});
export type StreamEventInput = z.infer<typeof StreamEventInput>;

/** A committed event: the input plus the identity the stream assigned at its commit point. */
export const StreamEvent = StreamEventInput.safeExtend({
  offset: z.number().int().positive(),
  createdAt: z.string(),
  path: z.string().trim().min(1),
});
export type StreamEvent = z.infer<typeof StreamEvent>;

// ── idempotency (apps/os semantics, message text kept greppable across RPC hops) ──

export function idempotencyConflictMessage(idempotencyKey: string, existingOffset: number): string {
  return `idempotency key "${idempotencyKey}" already names a different event at offset ${existingOffset}`;
}

/** Structural equality of the parts an idempotent retry must not change. */
export function sameIdempotentEvent(
  existing: StreamEventInput,
  requested: StreamEventInput,
): boolean {
  return (
    existing.type === requested.type &&
    jsonEqual(existing.payload, requested.payload) &&
    jsonEqual(existing.metadata, requested.metadata)
  );
}

/** Structural deep-equal over plain JSON values — THE one deep-equal in this package (idempotency
 *  bodies here, literal-arg matching in core/expression.ts). Object key ORDER is insignificant. */
export function jsonEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i], deeper(depth, "equal")));
  if (
    typeof a === "object" &&
    a !== null &&
    !Array.isArray(a) &&
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a as object);
    return (
      ka.length === Object.keys(b as object).length &&
      ka.every((k) =>
        jsonEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          deeper(depth, "equal"),
        ),
      )
    );
  }
  return false;
}
