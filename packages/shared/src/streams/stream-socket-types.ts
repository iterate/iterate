import { z } from "zod";
import { Event, EventInput } from "./types.ts";

export const StreamSocketEventFrame = z.strictObject({
  type: z.literal("event"),
  event: Event,
});
export type StreamSocketEventFrame = z.infer<typeof StreamSocketEventFrame>;

export const StreamSocketAppendFrame = z.strictObject({
  type: z.literal("append"),
  event: EventInput,
});
export type StreamSocketAppendFrame = z.infer<typeof StreamSocketAppendFrame>;

export const StreamSocketErrorFrame = z.strictObject({
  type: z.literal("error"),
  message: z.string().trim().min(1),
});
export type StreamSocketErrorFrame = z.infer<typeof StreamSocketErrorFrame>;

export const StreamSocketFrame = z.discriminatedUnion("type", [
  StreamSocketEventFrame,
  StreamSocketAppendFrame,
  StreamSocketErrorFrame,
]);
export type StreamSocketFrame = z.infer<typeof StreamSocketFrame>;
