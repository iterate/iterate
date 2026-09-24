// src/client/presence/processor.test.ts — the PresenceProcessor's reduce, declarative `{ events →
// state }` rows on the shared harness (iterate/stream/test-support `reduceProcessor`). The reduce folds
// durable `tick`s into `ticks`; the ephemeral `poke` is deliberately NOT reduced (it drives a runtime
// field, `#lastPokeMs`, that resets on eviction and never re-reduces).

import { expect, test } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import { PresenceProcessor } from "./processor.ts";

const rows: { name: string; events: { type: string; payload?: unknown }[]; ticks: number }[] = [
  { name: "no events → zero", events: [], ticks: 0 },
  {
    name: "each tick increments the reduced count",
    events: [{ type: "tick" }, { type: "tick" }, { type: "tick" }],
    ticks: 3,
  },
  {
    name: "a poke never reduces — only ticks count, however they interleave",
    events: [
      { type: "poke" },
      { type: "tick" },
      { type: "poke" },
      { type: "tick" },
      { type: "poke" },
    ],
    ticks: 2,
  },
];
for (const { name, events, ticks } of rows)
  test(`PresenceProcessor — ticks are reduced, pokes are runtime-only: ${name}`, () =>
    expect(reduceProcessor(new PresenceProcessor(), events)).toEqual({ ticks }));
