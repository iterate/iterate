// Executable spec for the stream's core processor — a REDUCE-ONLY processor (the inline lane):
// pause is a latch, the breaker is a token bucket refilled from EVENT time (never the clock),
// and control events are exempt so a tripped stream can always accept its own resume.
import { describe, expect, test } from "vitest";
import {
  breakerRemaining,
  CoreStreamProcessor,
  isCoreControl,
  type CoreState,
} from "./core-processor.ts";
import type { StreamEvent } from "./events.ts";

const proc = new CoreStreamProcessor();
const at = (ms: number, type: string, payload: Record<string, unknown> = {}): StreamEvent =>
  ({ type, payload, offset: ms, createdAt: new Date(ms).toISOString(), path: "/" }) as StreamEvent;
const reduceAll = (events: StreamEvent[], initial = proc.contract.initialState()): CoreState =>
  events.reduce((s, e) => proc.reduce({ event: e, state: s }) ?? s, initial);

describe("the core reduce", () => {
  test("pause is a latch: paused → resumed round-trips; reason carried", () => {
    const paused = reduceAll([
      at(1, "events.iterate.com/stream/paused", { reason: "maintenance" }),
    ]);
    expect(paused.paused).toEqual({ reason: "maintenance" });
    expect(reduceAll([at(2, "events.iterate.com/stream/resumed")], paused).paused).toBeNull();
  });

  test("the breaker spends one token per counted event and refills from EVENT time", () => {
    const s0 = reduceAll([
      at(0, "events.iterate.com/stream/breaker-configured", { capacity: 2, refillPerSecond: 1 }),
      at(1, "work"), // 2 → 1
      at(2, "work"), // 1 → 0
    ]);
    expect(s0.breaker?.tokens).toBeCloseTo(0, 2);
    // 500ms later: refilled 0.5, spend 1 → -0.5 reduced truth; enforcement math agrees
    const s1 = reduceAll([at(502, "work")], s0);
    expect(s1.breaker?.tokens).toBeCloseTo(-0.5, 1);
    // 3s after that the bucket is back at capacity (capped)
    expect(breakerRemaining(s1, 502 + 3000)).toBeCloseTo(2, 1);
  });

  test("an empty configure turns the breaker OFF; enforcement then reads Infinity", () => {
    const on = reduceAll([
      at(0, "events.iterate.com/stream/breaker-configured", { capacity: 5, refillPerSecond: 1 }),
    ]);
    const off = reduceAll([at(1, "events.iterate.com/stream/breaker-configured", {})], on);
    expect(off.breaker).toBeNull();
    expect(breakerRemaining(off, 999)).toBe(Infinity);
  });

  test("control events never spend a token (a tripped stream accepts its own resume)", () => {
    const s = reduceAll([
      at(0, "events.iterate.com/stream/breaker-configured", {
        capacity: 1,
        refillPerSecond: 0.001,
      }),
      at(1, "events.iterate.com/stream/paused", { reason: "x" }),
      at(2, "events.iterate.com/stream/resumed"),
    ]);
    expect(s.breaker?.tokens).toBe(1); // untouched
    expect(
      isCoreControl("events.iterate.com/stream/paused") &&
        isCoreControl("events.iterate.com/stream/resumed"),
    ).toBe(true);
    expect(isCoreControl("work")).toBe(false);
  });

  test("the reduce rebuilds bit-identically from the log (pure — no wall clock anywhere)", () => {
    const log = [
      at(0, "events.iterate.com/stream/breaker-configured", { capacity: 3, refillPerSecond: 2 }),
      at(100, "a"),
      at(1100, "b"),
      at(1200, "events.iterate.com/stream/paused", { reason: "r" }),
      at(5000, "events.iterate.com/stream/resumed"),
      at(9000, "c"),
    ];
    expect(reduceAll(log)).toEqual(reduceAll(log));
  });
});
