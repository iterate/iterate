import { z } from "zod";

/**
 * Maximum number of stream-to-stream copies retained in one event's provenance.
 * Cycles normally stop a chain earlier; this bounds acyclic graphs and the
 * serialized event growth they can produce.
 */
export const MAX_COPIED_FROM_HOPS = 32;

/** Append input before the stream assigns offset and timestamp. */
export const StreamEventInput = z.strictObject({
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  source: z
    .strictObject({
      // Stamped by the StreamProcessor append methods: which processor appended
      // this event, and — for per-event side effects — while processing which
      // event. `stream` is the processor's home stream (where `whileProcessing`
      // offsets resolve), recorded absolutely so the stamp stays meaningful on
      // rows appended cross-stream and on copies produced by a subscription. The stamp is a
      // claim, not authentication: same trust model as idempotency keys.
      processor: z
        .strictObject({
          slug: z.string(),
          version: z.string(),
          stream: z.strictObject({
            path: z.string().trim().min(1),
            projectId: z.string().trim().min(1).nullable(),
            /** Exact lifetime of the processor's home stream. */
            streamId: z.uuid(),
          }),
          whileProcessing: z
            .strictObject({
              offset: z.number().int().nonnegative(),
              type: z.string().trim().min(1),
            })
            .optional(),
        })
        .optional(),
      copiedFrom: z
        .array(
          z.strictObject({
            /** Name of the source stream's subscription that copied this event. */
            name: z.string().trim().min(1),
            /** Random identity assigned when that source stream's storage was created. */
            streamId: z.uuid(),
            /** Creation time of that source stream, used to order destructive recreations. */
            streamCreatedAt: z.string().trim().min(1),
            /** Configure or cursor-set event that started this delivered copy. */
            cursorChangedAtSourceOffset: z.number().int().positive(),
            createdAt: z.string(),
            offset: z.number().int().nonnegative(),
            path: z.string().trim().min(1),
            projectId: z.string().trim().min(1).nullable(),
            type: z.string().trim().min(1),
          }),
        )
        .min(1)
        .max(MAX_COPIED_FROM_HOPS)
        .optional(),
    })
    .optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  /**
   * Ephemeral events are second-class rows: committed and offset-ordered like
   * any event, but EXCLUDED from range reads unless explicitly requested
   * (`includeEphemeral: true`; point reads by offset or idempotency key
   * always return them). Durable subscriptions NEVER deliver them.
   * Session connections (`openConnection()`)
   * receive them only when appended after that exact connection opens;
   * historical ephemeral rows are never replayed. The stream may EVICT their
   * rows in the future (memory pressure, DO startup sweeps), so nothing
   * durable may ever depend on one: use them for transient signals whose
   * durable truth lands separately — LLM streaming chunks superseded by an
   * assistant `agents/context-added` item.
   * `z.literal(true)`, not boolean: absent = durable, so committed rows stay
   * self-describing and `ephemeral: false` is a loud input error, not a
   * silent synonym for omitting the flag.
   */
  ephemeral: z.literal(true).optional(),
});

// A committed event is an append input plus the fields the stream assigns at
// commit time. Deriving it from `StreamEventInput` keeps the shared `source` /
// `metadata` / `payload` shapes defined exactly once.
/** Durable stream event after commit. */
export const StreamEvent = StreamEventInput.extend({
  offset: z.number().int().nonnegative(),
  createdAt: z.string(),
  path: z.string().trim().min(1),
});

/**
 * One known stream in a project's reduced state — what the project processor
 * records per agent/repo/secret/stream and what the collection `list()`
 * methods return.
 */
export const StreamListItem = z.object({
  createdAt: z.string(),
  path: z.string(),
});

// The schemas above are the single definition of these shapes; the types are
// inferred, not hand-maintained (types.ts re-exports them for older importers).
/** Append input for `Stream.append`: event type, JSON payload, optional
 * metadata, provenance source, and idempotency key — everything before the
 * stream assigns offset and timestamp at commit. `ephemeral: true` commits a
 * second-class row: excluded from range reads unless `includeEphemeral`,
 * never delivered by durable subscriptions, and evictable —
 * for transient signals (LLM streaming chunks) whose durable truth lands as
 * its own event. */
export type StreamEventInput = z.infer<typeof StreamEventInput>;
/** One committed event on a durable stream: type, JSON payload, offset,
 * idempotency key, and provenance (processor stamp / source-stream chain), plus
 * the commit-time `createdAt` and stream `path`. `ephemeral: true` marks a
 * second-class row (see `StreamEventInput`). */
export type StreamEvent = z.infer<typeof StreamEvent>;
/** One known stream in a project's reduced state — the entry shape the
 * collection `list()` methods return: stream path plus creation time. */
export type StreamListItem = z.infer<typeof StreamListItem>;
