// The stream event envelope lives in the SDK (`iterate/sdk`, single zod
// definition in its stream-events module) so userspace and platform validate
// against the same shapes. This module re-binds the schema values under the
// platform's historical names; the type aliases are re-declared (not
// re-exported) because the itx api generator expands derived aliases from
// this module into the standalone generated surface.
import type { z } from "zod";
import { StreamEventInputSchema, StreamEventSchema, StreamListItemSchema } from "iterate/sdk";

export const StreamEventInput = StreamEventInputSchema;
export const StreamEvent = StreamEventSchema;
export const StreamListItem = StreamListItemSchema;

export type StreamEventInput = z.infer<typeof StreamEventInput>;
export type StreamEvent = z.infer<typeof StreamEvent>;
export type StreamListItem = z.infer<typeof StreamListItem>;
