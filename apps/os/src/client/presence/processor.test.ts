// src/client/presence/processor.test.ts — the PresenceProcessor's reduce, declarative `{ events →
// state }` rows on the shared harness (stream/test-support.ts `reduceProcessor`). The reduce folds
// durable `tick`s into `ticks`; the ephemeral `poke` is deliberately NOT reduced (it drives a runtime
// field, `#lastPokeMs`, that resets on eviction and never re-reduces).

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../../stream/test-support.ts";
import { PresenceProcessor } from "./processor.ts";

describe("PresenceProcessor — ticks are reduced, pokes are runtime-only", () => {
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
    test(name, () => expect(reduceProcessor(new PresenceProcessor(), events)).toEqual({ ticks }));
});
