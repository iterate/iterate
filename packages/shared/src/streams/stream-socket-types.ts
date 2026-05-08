import { z } from "zod";
import { Event, EventInput } from "./types.ts";

export const StreamSocketEventFrame = z.strictObject({
  type: z.literal("event"),
  event: Event,
});
export type StreamSocketEventFrame = z.infer<typeof StreamSocketEventFrame>;

export const StreamSocketEventsFrame = z.strictObject({
  type: z.literal("events"),
  events: z.array(Event).min(1),
});
export type StreamSocketEventsFrame = z.infer<typeof StreamSocketEventsFrame>;

export const StreamSocketAppendFrame = z.strictObject({
  type: z.literal("append"),
  requestId: z.string().trim().min(1).optional(),
  event: EventInput,
});
export type StreamSocketAppendFrame = z.infer<typeof StreamSocketAppendFrame>;

export const StreamSocketAppendResultFrame = z.strictObject({
  type: z.literal("append-result"),
  requestId: z.string().trim().min(1),
  event: Event,
});
export type StreamSocketAppendResultFrame = z.infer<typeof StreamSocketAppendResultFrame>;

export const StreamSocketAppendErrorFrame = z.strictObject({
  type: z.literal("append-error"),
  requestId: z.string().trim().min(1),
  message: z.string().trim().min(1),
});
export type StreamSocketAppendErrorFrame = z.infer<typeof StreamSocketAppendErrorFrame>;

export const StreamSocketAckFrame = z.strictObject({
  type: z.literal("ack"),
  offset: z.number().int().nonnegative(),
});
export type StreamSocketAckFrame = z.infer<typeof StreamSocketAckFrame>;

export const StreamSocketErrorFrame = z.strictObject({
  type: z.literal("error"),
  message: z.string().trim().min(1),
});
export type StreamSocketErrorFrame = z.infer<typeof StreamSocketErrorFrame>;

export const StreamSocketFrame = z.discriminatedUnion("type", [
  StreamSocketEventFrame,
  StreamSocketEventsFrame,
  StreamSocketAppendFrame,
  StreamSocketAppendResultFrame,
  StreamSocketAppendErrorFrame,
  StreamSocketAckFrame,
  StreamSocketErrorFrame,
]);
export type StreamSocketFrame = z.infer<typeof StreamSocketFrame>;
