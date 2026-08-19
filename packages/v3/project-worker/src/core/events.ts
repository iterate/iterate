// core/events.ts — the stream event envelope + idempotency rules + the zod contract helper.
// API mirrors apps/os (`packages/iterate/src/processors/schemas.ts` / `idempotency.ts`) so
// processors port both ways. This is the ZOD side of the processor world; the base class in
// core/processor.ts is dependency-free on purpose (it doubles as the injected userspace SDK).

import { z } from "zod";
import type { EventDefinition, ProcessorContract } from "./processor.ts";

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

/** THE delivery policy — one spelling for every host of it (the subscribe inputs, the provide
 *  payload, the projected PushRow). Rides the capability-provided event itself, so subscription
 *  config is event-sourced, never silent kv. Event rows get the cursor + retry/skip/halt
 *  ladder; `liveState` rows get neither — the key's change payloads are forwarded as they
 *  commit and the CLIENT chains revisions through the producer's door. */
export type DeliveryPolicy = {
  consumes?: string[];
  onFailingEvent?: "halt" | "skip";
  maxAttempts?: number;
  start?: "beginning" | "now";
  liveState?: { key: string };
};

/** What `append` accepts: the event body, before the stream assigns its committed identity. */
const eventInputShape = z.strictObject({
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
  /** An EPHEMERAL event rides the stream to live subscribers but is NEVER persisted: it consumes
   *  an offset (which survives as a valid gap), triggers zero reduce/cursor writes, and its body is
   *  gone the moment the incarnation ends — it cannot be redelivered by anyone. `ephemeral: false`
   *  is a loud input error, not a synonym for durable. */
  ephemeral: z.literal(true).optional(),
});
export const StreamEventInput = eventInputShape.refine(
  (e) => !(e.ephemeral && e.idempotencyKey),
  "ephemeral events cannot carry an idempotencyKey — nothing idempotent about the unreplayable",
);
export type StreamEventInput = z.infer<typeof StreamEventInput>;

/** A committed event: the input plus the identity the stream assigned at its commit point. */
export const StreamEvent = eventInputShape.safeExtend({
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
  const payloadOf = (type: string, payload: unknown, where: string): unknown => {
    const def = contract.events[type];
    if (!def)
      throw new Error(`contract "${contract.slug}": ${where} event type "${type}" is not owned`);
    return def.payloadSchema.parse(payload ?? {});
  };
  return {
    slug: contract.slug,
    version: contract.version,
    description: contract.description,
    consumes: contract.consumes,
    emits: contract.emits,
    stateSchema: contract.stateSchema,
    initialState: () => contract.stateSchema.parse({}) as z.infer<StateSchema>,
    buildEvent: (event) => ({
      type: event.type,
      payload: payloadOf(event.type, event.payload, "buildEvent") as Record<string, unknown>,
      ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
    }),
  };
}
