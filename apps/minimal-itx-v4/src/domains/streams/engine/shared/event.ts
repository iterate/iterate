import { z } from "zod";

export const StreamEventInput = z.object({
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  source: z
    .object({
      processor: z.object({ slug: z.string(), version: z.string() }).strict().optional(),
    })
    .strict()
    .optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
});
export type StreamEventInput = z.infer<typeof StreamEventInput>;

export const StreamEvent = z.object({
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  source: z
    .object({
      processor: z.object({ slug: z.string(), version: z.string() }).strict().optional(),
    })
    .strict()
    .optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  offset: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type StreamEvent = z.infer<typeof StreamEvent>;
