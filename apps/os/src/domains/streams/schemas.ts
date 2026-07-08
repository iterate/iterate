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
      processor: z.object({ slug: z.string(), version: z.string() }).strict().optional(),
      crossPostedFrom: z
        .array(
          z
            .object({
              ruleId: z.string().trim().min(1),
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
});

// A committed event is an append input plus the fields the stream assigns at
// commit time. Deriving it from `StreamEventInput` keeps the shared `source` /
// `metadata` / `payload` shapes defined exactly once.
/** Durable stream event after commit. */
export const StreamEvent = StreamEventInput.extend({
  offset: z.number().int().nonnegative(),
  createdAt: z.string(),
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
export type StreamEventInput = z.infer<typeof StreamEventInput>;
export type StreamEvent = z.infer<typeof StreamEvent>;
export type StreamListItem = z.infer<typeof StreamListItem>;
