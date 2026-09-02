// stream/events.ts — the stream event envelope + idempotency rules + the zod contract helper.
// API mirrors apps/os (`packages/iterate/src/processors/schemas.ts` / `idempotency.ts`) so
// processors port both ways. The zod schemas live HERE: the engine in stream/processor.ts imports
// only types from this module (plus lib/, live-state.ts and reduce-checkpoint.ts), so it runs
// schema-free; the SDK bundle ships both.

import { z } from "zod";
import { jsonEqual } from "../lib/patch.ts";
import type { EventDefinition, ProcessorContract } from "./processor.ts";
// THE one deep-equal lives in patch.ts (the live-state diff needs it dependency-free); the
// idempotency-body compare below is the same test, re-exported here for the SDK bundle.
export { jsonEqual };

/** What `append` accepts: the event body, before the stream assigns its committed identity. */
const EventInputShape = z.strictObject({
  /** Convention: `events.iterate.com/<domain>/<fact>`. */
  type: z.string().trim().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Provenance: which processor (while processing what) appended this. Stamped by the engine's `append`. */
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
  /** OPTIONAL PRECONDITION (apps/os): land at exactly this offset or refuse the whole batch with
   *  OFFSET_CONFLICT — "nothing has happened since I last looked". Never stored in the body. */
  offset: z.number().int().positive().optional(),
  /** An EPHEMERAL event rides the stream to live subscribers but is NEVER persisted: it consumes
   *  an offset (which survives as a valid gap), triggers zero reduce/cursor writes, and its body is
   *  gone the moment the incarnation ends — it cannot be redelivered by anyone. `ephemeral: false`
   *  is a loud input error, not a synonym for durable. */
  ephemeral: z.literal(true).optional(),
});
export const StreamEventInput = EventInputShape.refine(
  (event) => !(event.ephemeral && event.idempotencyKey),
  "ephemeral events cannot carry an idempotencyKey — nothing idempotent about the unreplayable",
);
export type StreamEventInput = z.infer<typeof StreamEventInput>;

/** A committed event: the input plus the identity the stream assigned at its commit point. */
export const StreamEvent = EventInputShape.safeExtend({
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
