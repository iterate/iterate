// core-processor.ts — THE STREAM'S CORE PROCESSOR, ported from apps/os (its stream DO "runs it
// inline during append instead of through the normal event-batch runner"; the same reducer
// "also maintains the stream's token-bucket circuit-breaker state"). A REDUCE-ONLY processor:
// its state is the stream's own operational truth — whether appends are PAUSED, and the
// token-bucket CIRCUIT BREAKER metering durable log growth. Control is ORDINARY EVENTS (pause/
// resume/reconfigure are appends — auditable, replayable, revocable like everything else);
// enforcement is the parent reading this reduce at the commit point. No verbs, no machinery:
//
//   itx.stream.append({ type: 'events.iterate.com/stream/paused',  payload: { reason } })
//   itx.stream.append({ type: 'events.iterate.com/stream/resumed' })
//   itx.stream.append({ type: 'events.iterate.com/stream/breaker-configured',
//                       payload: { capacity: 100, refillPerSecond: 1 } })   // omit → breaker OFF
//
// TIME RIDES THE EVENTS: the reduce refills the bucket from each counted event's own createdAt
// (a pure reduce may never consult the clock), so the checkpoint rebuilds bit-identically from
// the log. Only the parent's ENFORCEMENT (breakerRemaining below) uses the current time.
// Control events are exempt from pause and never spend a token — a tripped or paused stream
// must always accept its own resume.

import { z } from "zod";
import { defineProcessorContract, type StreamEvent } from "./core/events.ts";
import type { ReduceArgs, ReduceOnlyProcessor } from "./core/processor.ts";

export const STREAM_PAUSED = "events.iterate.com/stream/paused";
export const STREAM_RESUMED = "events.iterate.com/stream/resumed";
export const BREAKER_CONFIGURED = "events.iterate.com/stream/breaker-configured";
const CONTROL_TYPES = new Set([STREAM_PAUSED, STREAM_RESUMED, BREAKER_CONFIGURED]);

const CoreContract = defineProcessorContract({
  slug: "core",
  version: "1.0.0",
  description:
    "The stream's operational truth, reduced inline at the commit point: append pause and the token-bucket circuit breaker.",
  stateSchema: z.object({
    paused: z.object({ reason: z.string() }).nullable().default(null),
    breaker: z
      .object({
        capacity: z.number(),
        refillPerSecond: z.number(),
        tokens: z.number(),
        lastAtMs: z.number(),
      })
      .nullable()
      .default(null),
  }),
  events: {
    [STREAM_PAUSED]: {
      description: "Refuse every non-control append until resumed.",
      payloadSchema: z.object({ reason: z.string().default("paused") }),
    },
    [STREAM_RESUMED]: { payloadSchema: z.object({}) },
    [BREAKER_CONFIGURED]: {
      description: "Meter durable appends with a token bucket; an empty payload turns it off.",
      payloadSchema: z.object({
        capacity: z.number().positive().optional(),
        refillPerSecond: z.number().positive().optional(),
      }),
    },
  },
  consumes: ["*"],
  emits: [],
});

export type CoreState = z.infer<typeof CoreContract.stateSchema>;

export class CoreStreamProcessor implements ReduceOnlyProcessor<CoreState> {
  readonly contract = CoreContract;

  reduce({ event, state }: ReduceArgs<CoreState>): CoreState | undefined {
    if (event.type === STREAM_PAUSED) {
      const { reason } = (event.payload ?? {}) as { reason?: string };
      return { ...state, paused: { reason: reason ?? "paused" } };
    }
    if (event.type === STREAM_RESUMED) return { ...state, paused: null };
    if (event.type === BREAKER_CONFIGURED) {
      const { capacity, refillPerSecond } = (event.payload ?? {}) as {
        capacity?: number;
        refillPerSecond?: number;
      };
      if (!capacity || !refillPerSecond) return { ...state, breaker: null };
      return {
        ...state,
        breaker: { capacity, refillPerSecond, tokens: capacity, lastAtMs: eventMs(event) },
      };
    }
    // Every other durable event spends one token — refilled from EVENT time, so the reduce stays
    // pure and the checkpoint rebuilds identically from the log.
    if (state.breaker) {
      const at = eventMs(event);
      const refilled = refill(state.breaker, at);
      return { ...state, breaker: { ...state.breaker, tokens: refilled - 1, lastAtMs: at } };
    }
    return undefined;
  }
}

const eventMs = (event: StreamEvent): number => Date.parse(event.createdAt) || 0;
const refill = (
  b: { capacity: number; refillPerSecond: number; tokens: number; lastAtMs: number },
  nowMs: number,
): number =>
  Math.min(b.capacity, b.tokens + (Math.max(0, nowMs - b.lastAtMs) / 1000) * b.refillPerSecond);

/** ENFORCEMENT-side arithmetic (the only place wall-clock time enters): how many tokens the
 *  bucket holds right now. The parent refuses an append whose counted events exceed this. */
export function breakerRemaining(state: CoreState, nowMs: number): number {
  if (!state.breaker) return Infinity;
  return refill(state.breaker, nowMs);
}

/** Control events are exempt from pause and never spend — a stream must accept its own resume. */
export function isCoreControl(type: string): boolean {
  return CONTROL_TYPES.has(type);
}
