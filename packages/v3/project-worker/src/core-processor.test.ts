// Executable spec for the stream's core processor — a REDUCE-ONLY fold (the inline lane):
// pause is a latch, the breaker is a token bucket refilled from EVENT time (never the clock),
// and control events are exempt so a tripped stream can always accept its own resume.
import { describe, expect, test } from "vitest";
import {
  BREAKER_CONFIGURED,
  breakerRemaining,
  CoreStreamProcessor,
  isCoreControl,
  STREAM_PAUSED,
  STREAM_RESUMED,
  type CoreState,
} from "./core-processor.ts";
import type { StreamEvent } from "./core/events.ts";

const proc = new CoreStreamProcessor();
const at = (ms: number, type: string, payload: Record<string, unknown> = {}): StreamEvent =>
  ({ type, payload, offset: ms, createdAt: new Date(ms).toISOString(), path: "/" }) as StreamEvent;
const fold = (events: StreamEvent[], initial = proc.contract.initialState()): CoreState =>
  events.reduce((s, e) => proc.reduce({ event: e, state: s }) ?? s, initial);

describe("the core fold", () => {
  test("pause is a latch: paused → resumed round-trips; reason carried", () => {
    const paused = fold([at(1, STREAM_PAUSED, { reason: "maintenance" })]);
    expect(paused.paused).toEqual({ reason: "maintenance" });
    expect(fold([at(2, STREAM_RESUMED)], paused).paused).toBeNull();
  });

  test("the breaker spends one token per counted event and refills from EVENT time", () => {
    const s0 = fold([
      at(0, BREAKER_CONFIGURED, { capacity: 2, refillPerSecond: 1 }),
      at(1, "work"), // 2 → 1
      at(2, "work"), // 1 → 0
    ]);
    expect(s0.breaker?.tokens).toBeCloseTo(0, 2);
    // 500ms later: refilled 0.5, spend 1 → -0.5 folded truth; enforcement math agrees
    const s1 = fold([at(502, "work")], s0);
    expect(s1.breaker?.tokens).toBeCloseTo(-0.5, 1);
    // 3s after that the bucket is back at capacity (capped)
    expect(breakerRemaining(s1, 502 + 3000)).toBeCloseTo(2, 1);
  });

  test("an empty configure turns the breaker OFF; enforcement then reads Infinity", () => {
    const on = fold([at(0, BREAKER_CONFIGURED, { capacity: 5, refillPerSecond: 1 })]);
    const off = fold([at(1, BREAKER_CONFIGURED, {})], on);
    expect(off.breaker).toBeNull();
    expect(breakerRemaining(off, 999)).toBe(Infinity);
  });

  test("control events never spend a token (a tripped stream accepts its own resume)", () => {
    const s = fold([
      at(0, BREAKER_CONFIGURED, { capacity: 1, refillPerSecond: 0.001 }),
      at(1, STREAM_PAUSED, { reason: "x" }),
      at(2, STREAM_RESUMED),
    ]);
    expect(s.breaker?.tokens).toBe(1); // untouched
    expect(isCoreControl(STREAM_PAUSED) && isCoreControl(STREAM_RESUMED)).toBe(true);
    expect(isCoreControl("work")).toBe(false);
  });

  test("the fold rebuilds bit-identically from the log (pure — no wall clock anywhere)", () => {
    const log = [
      at(0, BREAKER_CONFIGURED, { capacity: 3, refillPerSecond: 2 }),
      at(100, "a"),
      at(1100, "b"),
      at(1200, STREAM_PAUSED, { reason: "r" }),
      at(5000, STREAM_RESUMED),
      at(9000, "c"),
    ];
    expect(fold(log)).toEqual(fold(log));
  });
});
