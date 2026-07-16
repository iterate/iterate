import { z } from "zod";

/** Append input before the stream assigns offset and timestamp. */
export const StreamEventInput = z.object({
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Deliberately NOT strict: committed rows are re-parsed through this schema
  // on every read (stream-storage.ts), so a strict envelope would poison
  // every stream holding an event with a retired source shape (e.g. the
  // pre-chain `crossPost` object). Unknown keys strip on read; the row is
  // untouched.
  source: z
    .object({
      // Stamped by the StreamProcessor append lanes: which processor appended
      // this event, and — for per-event side effects — while processing which
      // event. `stream` is the processor's home stream (where `whileProcessing`
      // offsets resolve), recorded absolutely so the stamp stays meaningful on
      // rows appended cross-stream and on cross-posted copies. The stamp is a
      // claim, not authentication: same trust model as idempotency keys.
      // Deliberately not strict (see the envelope comment above): a retired
      // stamp field must strip on read, not poison the row.
      processor: z
        .object({
          slug: z.string(),
          version: z.string(),
          stream: z.object({
            path: z.string().trim().min(1),
            projectId: z.string().trim().min(1).nullable(),
          }),
          whileProcessing: z
            .object({
              offset: z.number().int().nonnegative(),
              type: z.string().trim().min(1),
            })
            .optional(),
        })
        .optional(),
      crossPostedFrom: z
        .array(
          z
            .object({
              /** The push subscription (on the SOURCE stream) that carried this hop. */
              subscriptionKey: z.string().trim().min(1),
              createdAt: z.string(),
              offset: z.number().int().nonnegative(),
              path: z.string().trim().min(1),
              projectId: z.string().trim().min(1).nullable(),
              type: z.string().trim().min(1),
            })
            .strict(),
        )
        .min(1)
        .optional(),
    })
    .optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  /**
   * Ephemeral events are second-class rows: committed and offset-ordered like
   * any event, but EXCLUDED from range reads unless explicitly requested
   * (`includeEphemeral: true`; point reads by offset or idempotency key
   * always return them) and never delivered to the durable subscription
   * lanes (wake/push/webhook) — so subscription-fed processors cannot fold
   * them or side-effect on them. Ephemeral subscriptions (`subscribe()`)
   * receive them only when appended after that exact subscription opens;
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
 * never delivered to durable subscribers (wake/push/webhook), and evictable —
 * for transient signals (LLM streaming chunks) whose durable truth lands as
 * its own event. */
export type StreamEventInput = z.infer<typeof StreamEventInput>;
/** One committed event on a durable stream: type, JSON payload, offset,
 * idempotency key, and provenance (processor stamp / cross-post chain), plus
 * the commit-time `createdAt` and stream `path`. `ephemeral: true` marks a
 * second-class row (see `StreamEventInput`). */
export type StreamEvent = z.infer<typeof StreamEvent>;
/** One known stream in a project's reduced state — the entry shape the
 * collection `list()` methods return: stream path plus creation time. */
export type StreamListItem = z.infer<typeof StreamListItem>;
