// The canonical stream event schemas live in iterate/sdk so project-defined
// and platform-defined processors validate the same wire shapes.
import { StreamEventInputSchema, StreamEventSchema, StreamListItemSchema } from "iterate/sdk";
import type {
  StreamEventInput as StreamEventInputType,
  StreamEvent as StreamEventType,
  StreamListItem as StreamListItemType,
} from "../../itx-api.generated.ts";

export const StreamEventInput = StreamEventInputSchema;
export const StreamEvent = StreamEventSchema;
export const StreamListItem = StreamListItemSchema;

/** Append input for `Stream.append`: event type, JSON payload, optional
 * metadata, provenance source, and idempotency key — everything before the
 * stream assigns offset and timestamp at commit. `ephemeral: true` commits a
 * second-class row: excluded from range reads unless `includeEphemeral`,
 * never delivered to durable subscribers (wake/push/webhook), and evictable —
 * for transient signals (LLM streaming chunks) whose durable truth lands as
 * its own event. */
export type StreamEventInput = StreamEventInputType;

/** One committed event on a durable stream: type, JSON payload, offset,
 * idempotency key, and provenance (processor stamp / cross-post chain), plus
 * the commit-time `createdAt` and stream `path`. `ephemeral: true` marks a
 * second-class row (see `StreamEventInput`). */
export type StreamEvent = StreamEventType;

/** One known stream in a project's reduced state — the entry shape the
 * collection `list()` methods return: stream path plus creation time. */
export type StreamListItem = StreamListItemType;
