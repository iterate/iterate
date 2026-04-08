import { z } from "zod";
import {
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
} from "./event-base-types.ts";

export const StreamPausedEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/paused"),
  payload: z.strictObject({
    reason: z.string().trim().min(1).optional(),
  }),
});
export const StreamPausedEvent = GenericEventBase.extend(
  StreamPausedEventInput.pick({ type: true, payload: true }).shape,
);
export type StreamPausedEventInput = z.infer<typeof StreamPausedEventInput>;
export type StreamPausedEvent = z.infer<typeof StreamPausedEvent>;

export const StreamResumedEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/resumed"),
  payload: z.strictObject({
    reason: z.string().trim().min(1).optional(),
  }),
});
export const StreamResumedEvent = GenericEventBase.extend(
  StreamResumedEventInput.pick({ type: true, payload: true }).shape,
);
export type StreamResumedEventInput = z.infer<typeof StreamResumedEventInput>;
export type StreamResumedEvent = z.infer<typeof StreamResumedEvent>;

export const CircuitBreakerState = z.object({
  paused: z.boolean(),
  pauseReason: z.string().nullable(),
  pausedAt: z.string().nullable(),
  recentEventTimestamps: z.array(z.string()),
});
export type CircuitBreakerState = z.infer<typeof CircuitBreakerState>;

export class StreamPausedError extends Error {
  constructor() {
    super("stream is paused; only stream/resumed is allowed");
    this.name = "StreamPausedError";
  }
}
