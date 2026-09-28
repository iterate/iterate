// Folding the log for reading: days, housekeeping runs, repeated facts — and that the raw modes fold nothing.
// The fixture's two days sit 48 h apart at noon UTC, so they are two local days in every timezone.
import { expect, test } from "vitest";
import {
  factByPayload,
  foldEvents,
  growthOf,
  lastEventOf,
  refold,
  sentenceText,
  whoBefore,
  type FeedItem,
  type Fold,
} from "./folds.tsx";
import {
  filterEvents,
  recount,
  refilter,
  typeCounts,
  type Filtered,
  type TypeCounts,
} from "./filters.tsx";
import { housekeepingSummary } from "./core-renderers.tsx";
import type { ContextViewEvent } from "./types.tsx";

const log: ContextViewEvent[] = [
  at(1, "events.iterate.com/itx/created", { path: "/" }),
  at(2, "events.iterate.com/itx/woken", { incarnation: 1 }),
  at(3, "events.iterate.com/itx/subscription-configured", { name: "account" }),
  at(4, "events.iterate.com/account/authenticated", { credential: "cookie" }),
  at(5, "events.iterate.com/account/authenticated", { credential: "cookie" }),
  at(6, "events.iterate.com/account/authenticated", { credential: "cookie" }),
  at(7, "events.iterate.com/account/authenticated", { credential: "admin-secret" }),
  at(8, "events.iterate.com/itx/woken", { incarnation: 2 }, "2026-09-23T12:00:00.000Z"),
  at(
    9,
    "events.iterate.com/itx/subscription-configured",
    { name: "sub-1" },
    "2026-09-23T12:00:00.000Z",
  ),
  at(10, "events.iterate.com/itx/live-state-changed", undefined, "2026-09-23T12:00:01.000Z"),
  at(
    11,
    "events.iterate.com/account/personal-access-token-minted",
    { id: "pat_a" },
    "2026-09-23T12:00:02.000Z",
  ),
];

// ── foldEvents ──
test("pretty: a day mark, housekeeping runs folded, a repeated fact shown once with its count", () => {
  const items = foldEvents(log, "pretty");
  expect(items.map((item) => item.kind)).toEqual([
    "day",
    "event", // born
    "housekeeping", // woken + subscription
    "repeat", // 3 cookie sign-ins
    "event", // the admin-secret sign-in differs in payload
    "day",
    "housekeeping", // woken + subscription + live state
    "event", // grant minted
  ]);
  const repeat = items[3];
  expect(repeat.kind === "repeat" && repeat.events.map((e) => e.offset)).toEqual([4, 5, 6]);
  const housekeeping = items[6];
  expect(housekeeping.kind === "housekeeping" && housekeeping.events.length).toBe(3);
});
test("a lone housekeeping event stays a plain row; a run never crosses a day", () => {
  const items = foldEvents([log[0]!, log[1]!, log[3]!], "pretty");
  expect(items.map((item) => item.kind)).toEqual(["day", "event", "event", "event"]);
  const acrossDays = foldEvents([log[1]!, log[7]!], "pretty");
  expect(acrossDays.map((item) => item.kind)).toEqual(["day", "event", "day", "event"]);
});
test("pretty + raw and raw keep every event; only the days are marked", () => {
  for (const mode of ["pretty-raw", "raw"] as const) {
    const items = foldEvents(log, mode);
    expect(items.filter((item) => item.kind === "event")).toHaveLength(log.length);
    expect(items.filter((item) => item.kind === "day")).toHaveLength(2);
  }
});
test("lastEventOf anchors the next gap at the end of a fold", () => {
  const items = foldEvents(log, "pretty");
  expect(lastEventOf(items[3])?.offset).toBe(6);
  expect(lastEventOf(items[0])).toBeUndefined();
});

test("housekeepingSummary counts by kind", () => {
  expect(
    housekeepingSummary([log[1]!, log[2]!, log[7]!, log[8]!, log[9]!].map((e) => e.type)),
  ).toBe("woke ×2, subscription ×2, live state");
});

// ── the same fact is the same sentence ──
test("payloads that differ only in timestamps and ids fold when a fact key says they read the same", () => {
  const signIns = [
    at(1, "events.iterate.com/account/authenticated", {
      credential: "cookie",
      at: 1,
      operationId: "a",
    }),
    at(2, "events.iterate.com/account/authenticated", {
      credential: "cookie",
      at: 2,
      operationId: "b",
    }),
    at(3, "events.iterate.com/account/authenticated", {
      credential: "admin-secret",
      at: 3,
      operationId: "c",
    }),
  ];
  expect(foldEvents(signIns, "pretty").map((item) => item.kind)).toEqual([
    "day",
    "event",
    "event",
    "event",
  ]);
  expect(
    foldEvents(
      signIns,
      "pretty",
      // the sentence would read the credential only — so key by it
      (event) => `${event.type}:${String((event.payload as { credential: string }).credential)}`,
    ).map((item) => item.kind),
  ).toEqual(["day", "repeat", "event"]);
});
test("sentenceText walks strings, numbers, arrays and elements' children", () => {
  expect(
    sentenceText(
      <>
        Approved <strong>Claude Code</strong> for {1} project{["(s)", null, false]}
      </>,
    ),
  ).toBe("Approved Claude Code for 1 project(s)");
});

test("whoBefore: carries the last named actor over housekeeping, starts afresh at a day mark", () => {
  const named = (offset: number, actor: string, iso?: string): ContextViewEvent => ({
    ...at(
      offset,
      "events.iterate.com/account/personal-access-token-minted",
      { id: `pat_${String(offset)}` },
      iso,
    ),
    source: { principal: { actor } },
  });
  const items = foldEvents(
    [
      named(1, "user_a"),
      at(2, "events.iterate.com/itx/woken", { incarnation: 2 }),
      named(3, "user_a"),
      named(4, "user_b"),
      named(5, "user_b", "2026-09-23T12:00:00.000Z"),
    ],
    "pretty",
  );
  expect(items.map((item) => item.kind)).toEqual([
    "day",
    "event",
    "event",
    "event",
    "event",
    "day",
    "event",
  ]);
  expect(whoBefore(items, (e) => e.source?.principal?.actor || "")).toEqual([
    "",
    "",
    "user_a",
    "user_a",
    "user_a",
    "",
    "",
  ]);
  // so: #1 named (first), woke unnamed, #3 not named again (still user_a), #4 named (changed), #5 named (new day)
});

// ── the incremental passes equal the whole ones ──
// A log of runs (repeats, housekeeping, lone events, actors changing hands) across three days, grown
// the way the SDK's log grows: the newest page first, then older pages prepended and live events
// appended, a few at a time, with ends that split runs and days. After every step the incremental
// fold, filter and type counts must equal the whole passes over the log as it stands.
const grown = growingLog(240);
const growths: {
  name: string;
  /** The first window of the log, [low, high). */
  from: [number, number];
  steps: ("append" | "prepend")[];
  sizes: number[];
}[] = [
  { name: "appends one at a time", from: [0, 1], steps: ["append"], sizes: [1] },
  { name: "prepends one at a time", from: [239, 240], steps: ["prepend"], sizes: [1] },
  {
    name: "pages both ways",
    from: [150, 160],
    steps: ["prepend", "append", "append"],
    sizes: [7, 1, 3, 40],
  },
  {
    name: "big prepends, small appends",
    from: [150, 160],
    steps: ["prepend", "append"],
    sizes: [97, 2],
  },
];
for (const growth of growths)
  for (const mode of ["pretty", "pretty-raw", "raw"] as const)
    test(`refold, refilter, recount: ${growth.name}, ${mode}`, () => {
      const actorOf = (event: ContextViewEvent) => event.source?.principal?.actor || "";
      const filter = {
        query: "",
        types: new Set(["t.example.com/a", "events.iterate.com/itx/woken"]),
      };
      let [low, high] = growth.from;
      let fold: Fold | undefined;
      let filtered: Filtered | undefined;
      let counts: TypeCounts | undefined;
      let filteredFold: Fold | undefined;
      for (let step = 0; low > 0 || high < grown.length; step += 1) {
        const size = growth.sizes[step % growth.sizes.length]!;
        const direction = growth.steps[step % growth.steps.length]!;
        if (direction === "prepend") low = Math.max(0, low - size);
        else high = Math.min(grown.length, high + size);
        // a fresh array each step, as the SDK publishes, holding the same event objects
        const log = grown.slice(low, high);
        fold = refold(fold, log, mode, factByPayload, actorOf);
        const whole = foldEvents(log, mode);
        expect(fold.items.map(shape)).toEqual(whole.map(shape));
        expect(fold).toMatchObject({ namedBefore: whoBefore(whole, actorOf) });
        filtered = refilter(filtered, log, filter);
        expect(filtered.shown.map((e) => e.offset)).toEqual(
          filterEvents(log, filter).map((e) => e.offset),
        );
        filteredFold = refold(filteredFold, filtered.shown, mode, factByPayload, actorOf);
        expect(filteredFold.items.map(shape)).toEqual(
          foldEvents(filterEvents(log, filter), mode).map(shape),
        );
        counts = recount(counts, log);
        expect([...counts.counts.entries()].sort()).toEqual(typeCounts(log).sort());
      }
    });

// growthOf compares items by identity; distinct strings stand in for distinct events.
test.for([
  { name: "an append", previous: ["a", "b"], next: ["a", "b", "c"], growth: { end: ["c"] } },
  { name: "a prepend", previous: ["b", "c"], next: ["a", "b", "c"], growth: { start: ["a"] } },
  { name: "grew in the middle", previous: ["a", "c"], next: ["a", "b", "c"], growth: null },
  { name: "shrank", previous: ["a", "b", "c"], next: ["a", "b"], growth: null },
  {
    name: "grew at both ends at once",
    previous: ["b", "d"],
    next: ["a", "b", "c", "d"],
    growth: null,
  },
])("growthOf: $name", ({ previous, next, growth }) => {
  expect(growthOf(previous, next)).toEqual(growth);
});

test("growthOf: the same array grew by nothing", () => {
  const same = ["a", "b"];
  expect(growthOf(same, same)).toEqual({ end: [] });
});

/** An item as a line: its kind, key and the offsets it covers. */
function shape(item: FeedItem): string {
  if (item.kind === "day") return item.key;
  const offsets = item.kind === "event" ? [item.event.offset] : item.events.map((e) => e.offset);
  return `${item.key} ${offsets.join(",")}`;
}

/** `count` events over three days: runs of one fact (repeats), runs of housekeeping, lone events,
 *  and actors changing hands every so often. */
function growingLog(count: number): ContextViewEvent[] {
  return Array.from({ length: count }, (_, i) => {
    const day = i < 80 ? "2026-09-21" : i < 170 ? "2026-09-23" : "2026-09-25";
    const iso = `${day}T12:00:${String(i % 60).padStart(2, "0")}.000Z`;
    const k = i % 23;
    const type =
      k < 5
        ? "t.example.com/a" // a run of five of the same fact
        : k < 9
          ? "events.iterate.com/itx/woken" // housekeeping
          : `t.example.com/unique-${String(i)}`;
    const payload = k < 5 ? { same: true } : { i };
    return {
      ...at(i + 1, type, payload, iso),
      ...(i % 11 < 6 && { source: { principal: { actor: i % 3 ? "user_a" : "user_b" } } }),
    };
  });
}

function at(offset: number, type: string, payload?: unknown, iso = "2026-09-21T19:00:00.000Z") {
  return {
    offset,
    type,
    createdAt: iso,
    payload,
  } satisfies ContextViewEvent;
}
