/**
 * Stream event model: append input / committed event types and zod schemas.
 *
 * The Durable Object storage helpers that used to live here (output-gate-aware
 * SQL/KV append and read paths) were deleted with the legacy processor model;
 * the Stream DO owns its storage access directly.
 */
import { z } from "zod";

export type StreamEventSource = {
  processor?: {
    slug: string;
    version: string;
  };
};

/** Append input for a stream event. Generic `Type` / `Payload` are used by stream processors. */
export type StreamEventInput<Type extends string = string, Payload = unknown> = {
  type: Type;
  payload?: Payload;
  metadata?: Record<string, unknown>;
  source?: StreamEventSource;
  idempotencyKey?: string;
  /** Precondition: must equal the next offset when set. */
  offset?: number;
};

/** Committed stream event. The owning stream is clear from context (reduced state). */
export type StreamEvent<Type extends string = string, Payload = unknown> = StreamEventInput<
  Type,
  Payload
> & {
  offset: number;
  createdAt: string;
};

export const StreamEventMetadata = z.record(z.string(), z.unknown());
export const streamEventOffsetSchema = z.number().int().nonnegative();
export const StreamEventCreatedAt = z.string();
export const streamEventCreatedAtIsoSchema = z.iso.datetime({ offset: true });
export const streamEventPathSchema = z.string().trim().min(1);

export const StreamEventInput = z.object({
  type: z.string(),
  payload: z.unknown().optional(),
  metadata: StreamEventMetadata.optional(),
  source: z
    .object({
      processor: z
        .object({
          slug: z.string(),
          version: z.string(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  idempotencyKey: z.string().optional(),
  /** Precondition: must equal the next offset when set. */
  offset: streamEventOffsetSchema.optional(),
});

export const StreamEvent = StreamEventInput.extend({
  offset: streamEventOffsetSchema,
  createdAt: StreamEventCreatedAt,
});
