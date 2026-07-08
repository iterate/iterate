import { z } from "zod";
import type {
  StreamEvent as StreamEventType,
  StreamEventInput as StreamEventInputType,
} from "../../types.ts";

export const StreamEventInput = z.object({
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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
    .strict()
    .optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
}) satisfies z.ZodType<StreamEventInputType, unknown>;

// A committed event is an append input plus the fields the stream assigns at
// commit time. Deriving it from `StreamEventInput` keeps the shared `source` /
// `metadata` / `payload` shapes defined exactly once.
export const StreamEvent = StreamEventInput.extend({
  offset: z.number().int().nonnegative(),
  createdAt: z.string(),
}) satisfies z.ZodType<StreamEventType, unknown>;
