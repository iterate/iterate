// core-processor.ts — THE STREAM'S CORE PROCESSOR, ported from apps/os (its stream DO "runs it
// inline during append instead of through the normal event-batch runner"; the same reducer
// "also maintains the stream's token-bucket circuit-breaker state"). A REDUCE-ONLY processor:
// its state is the stream's own operational truth — whether appends are PAUSED, and the
// token-bucket CIRCUIT BREAKER metering durable log growth. Control is ORDINARY EVENTS (pause/
// resume/reconfigure are appends — auditable, replayable, revocable like everything else);
// enforcement is the parent reading this reduce at the commit point. No verbs, no machinery:
//
//   itx.append({ type: 'events.iterate.com/stream/paused',  payload: { reason } })
//   itx.append({ type: 'events.iterate.com/stream/resumed' })
//   itx.append({ type: 'events.iterate.com/stream/breaker-configured',
//                       payload: { capacity: 100, refillPerSecond: 1 } })   // omit → breaker OFF
//
// TIME RIDES THE EVENTS: the reduce refills the bucket from each counted event's own createdAt
// (a pure reduce may never consult the clock), so the checkpoint rebuilds bit-identically from
// the log. Only the parent's ENFORCEMENT (breakerRemaining below) uses the current time.
// Control events are exempt from pause and never spend a token — a tripped or paused stream
// must always accept its own resume.

import { z } from "zod";
import { defineProcessorContract, type StreamEvent, type StreamEventInput } from "./core/events.ts";
import type { ReduceArgs, ReduceOnlyProcessor } from "./core/processor.ts";
import { codedError } from "./core/errors.ts";

const CONTROL_TYPES = new Set([
  "events.iterate.com/stream/paused",
  "events.iterate.com/stream/resumed",
  "events.iterate.com/stream/breaker-configured",
]);

const CoreContract = defineProcessorContract({
  slug: "core",
  version: "1.1.0", // 1.1.0: reduces stream/woken into `incarnation` (stale checkpoints refold)
  description:
    "The stream's operational truth, reduced inline at the commit point: the current incarnation, append pause, and the token-bucket circuit breaker.",
  stateSchema: z.object({
    /** From the wake record (stream/woken) — absent until the stream's first-ever commit reduces
     *  one. Growth across idle is the hibernation tell, now readable as ordinary reduced state. */
    incarnation: z.number().optional(),
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
    "events.iterate.com/stream/woken": {
      description:
        "The platform's wake record — the Stream prepends it into the first committed batch of each incarnation (never appended by clients or this processor).",
      payloadSchema: z.object({ incarnation: z.number() }),
    },
    "events.iterate.com/stream/paused": {
      description: "Refuse every non-control append until resumed.",
      payloadSchema: z.object({ reason: z.string().default("paused") }),
    },
    "events.iterate.com/stream/resumed": { payloadSchema: z.object({}) },
    "events.iterate.com/stream/breaker-configured": {
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
    if (event.type === "events.iterate.com/stream/woken") {
      // The platform's own wake record (injected by Stream.append after admission, once per
      // incarnation): fold the incarnation and spend NO token — the wake is never client growth.
      const { incarnation } = (event.payload ?? {}) as { incarnation?: number };
      return { ...state, incarnation };
    }
    if (event.type === "events.iterate.com/stream/paused") {
      const { reason } = (event.payload ?? {}) as { reason?: string };
      return { ...state, paused: { reason: reason ?? "paused" } };
    }
    if (event.type === "events.iterate.com/stream/resumed") return { ...state, paused: null };
    if (event.type === "events.iterate.com/stream/breaker-configured") {
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

/** THE admission decision — the parent's enforcement, reading this reduce at the commit point: a
 *  paused stream refuses every non-control append; the token-bucket breaker meters DURABLE growth.
 *  Throws STREAM_PAUSED / STREAM_BREAKER_OPEN; a clean return admits the batch. Control events always
 *  pass. `hasIdempotencyKey` lets a reconciling retry through a tight bucket — a retry of an
 *  already-committed key dedupes to zero durable growth, and the breaker meters GROWTH, so it isn't
 *  taxed. The dedupe probe runs ONLY on the about-to-trip path, so the common case pays no SELECT. */
export function admit(
  state: CoreState,
  inputs: StreamEventInput[],
  nowMs: number,
  hasIdempotencyKey: (key: string) => boolean,
): void {
  const nonControl = inputs.filter((i) => !isCoreControl(i.type));
  if (nonControl.length === 0) return;
  if (state.paused) throw codedError("STREAM_PAUSED", `stream paused: ${state.paused.reason}`);
  let counted = nonControl.filter((i) => !i.ephemeral).length;
  if (counted > 0 && breakerRemaining(state, nowMs) < counted) {
    counted = nonControl.filter(
      (i) => !i.ephemeral && !(i.idempotencyKey && hasIdempotencyKey(i.idempotencyKey)),
    ).length;
    if (counted > 0 && breakerRemaining(state, nowMs) < counted)
      throw codedError(
        "STREAM_BREAKER_OPEN",
        `stream circuit breaker open — ${counted} durable event(s) exceed the bucket`,
      );
  }
}
