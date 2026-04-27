import { z } from "zod";
import {
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
} from "./event-base-types.ts";

const iterateEventUriPrefix = "https://events.iterate.com/" as const;

export const STREAM_CIRCUIT_BREAKER_CONFIGURED_TYPE =
  `${iterateEventUriPrefix}events/stream/circuit-breaker-configured` as const;

export const CircuitBreakerConfig = z.strictObject({
  burstCapacity: z.number().int().positive(),
  refillRatePerMinute: z.number().int().positive(),
});
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfig>;

export const CircuitBreakerConfiguredEventInput = GenericEventInputBase.extend({
  type: z.literal(STREAM_CIRCUIT_BREAKER_CONFIGURED_TYPE),
  payload: CircuitBreakerConfig,
});
export const CircuitBreakerConfiguredEvent = GenericEventBase.extend(
  CircuitBreakerConfiguredEventInput.pick({ type: true, payload: true }).shape,
);
export type CircuitBreakerConfiguredEventInput = z.infer<typeof CircuitBreakerConfiguredEventInput>;
export type CircuitBreakerConfiguredEvent = z.infer<typeof CircuitBreakerConfiguredEvent>;

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
  config: CircuitBreakerConfig.default({
    burstCapacity: 500,
    refillRatePerMinute: 500,
  }),
  availableTokens: z.number(),
  lastRefillAtMs: z.number().int().nonnegative().nullable(),
});
export type CircuitBreakerState = z.infer<typeof CircuitBreakerState>;

export class StreamPausedError extends Error {
  constructor() {
    super("stream is paused; only stream/resumed is allowed");
    this.name = "StreamPausedError";
  }
}
