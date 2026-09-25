// The context view's pure halves: filtering the log, counting its types, matching a renderer by
// exact type or the most specific prefix, and the row's short forms.
import { expect, test } from "vitest";
import {
  filterEvents,
  offsetBound,
  payloadPreview,
  payloadSummary,
  refilter,
  shortEventType,
  typeChips,
  typeCounts,
  type ContextViewFilter,
} from "./filters.tsx";
import { rendererFor, type ContextViewEvent } from "./types.tsx";

const EMPTY_FILTER: ContextViewFilter = { query: "", types: new Set() };

const log = [
  at(1, "events.iterate.com/itx/created", { path: "/" }),
  at(
    2,
    "events.iterate.com/account/personal-access-token-minted",
    { id: "pat_a", name: "laptop" },
    "user_1",
  ),
  at(3, "events.iterate.com/account/grant-ended", { grantId: "pat_a" }, "user_2"),
  at(
    4,
    "events.iterate.com/account/personal-access-token-minted",
    { id: "pat_b", name: "phone" },
    "user_1",
  ),
];

// ── filterEvents ──
test("no filter shows everything; types narrow to the set; the query searches type and payload; an actor narrows to theirs", () => {
  expect(filterEvents(log, EMPTY_FILTER)).toHaveLength(4);
  expect(
    filterEvents(log, {
      query: "",
      types: new Set(["events.iterate.com/account/personal-access-token-minted"]),
    }).map((e) => e.offset),
  ).toEqual([2, 4]);
  expect(filterEvents(log, { query: "phone", types: new Set() }).map((e) => e.offset)).toEqual([4]);
  expect(
    filterEvents(log, { query: "GRANT-ENDED", types: new Set() }).map((e) => e.offset),
  ).toEqual([3]);
  expect(
    filterEvents(log, { query: "", types: new Set(), actor: "user_2" }).map((e) => e.offset),
  ).toEqual([3]);
});

// ── the offset range ──
test.for([
  { name: "from alone", range: { from: 3 }, shown: [3, 4] },
  { name: "to alone", range: { to: 2 }, shown: [1, 2] },
  { name: "both, inclusive", range: { from: 2, to: 3 }, shown: [2, 3] },
  { name: "one offset", range: { from: 4, to: 4 }, shown: [4] },
  { name: "an empty range", range: { from: 4, to: 2 }, shown: [] },
  { name: "with a type", range: { from: 3, types: new Set([log[1]!.type]) }, shown: [4] },
])("offsets: $name", ({ range, shown }) => {
  expect(filterEvents(log, { ...EMPTY_FILTER, ...range }).map((e) => e.offset)).toEqual(shown);
});

test("refilter follows a growing log under an offset range, and a new bound filters again", () => {
  const first = refilter(undefined, log.slice(0, 3), { ...EMPTY_FILTER, from: 2 });
  expect(first.shown.map((e) => e.offset)).toEqual([2, 3]);
  const grown = refilter(first, log, { ...EMPTY_FILTER, from: 2 });
  expect(grown.shown.map((e) => e.offset)).toEqual([2, 3, 4]);
  expect(refilter(grown, log, { ...EMPTY_FILTER, from: 4 }).shown.map((e) => e.offset)).toEqual([
    4,
  ]);
});

test.for([
  { text: "", bound: undefined },
  { text: "  ", bound: undefined },
  { text: "12", bound: 12 },
  { text: " #12 ", bound: 12 },
  { text: "-5", bound: 0 },
  { text: "3.9", bound: 3 },
  { text: "abc", bound: null },
  { text: "1e400", bound: null },
])("offsetBound($text) = $bound", ({ text, bound }) => {
  expect(offsetBound(text)).toBe(bound);
});

// ── typeChips ──
test.for([
  {
    name: "nothing ticked: the counts as they are",
    ticked: [],
    chips: [
      ["a", 2],
      ["b", 1],
    ],
  },
  {
    name: "a ticked type in the log: no extra chip",
    ticked: ["a"],
    chips: [
      ["a", 2],
      ["b", 1],
    ],
  },
  {
    name: "ticked types the log lacks: after the counts, at 0, sorted",
    ticked: ["z", "a", "c"],
    chips: [
      ["a", 2],
      ["b", 1],
      ["c", 0],
      ["z", 0],
    ],
  },
])("typeChips: $name", ({ ticked, chips }) => {
  expect(
    typeChips(
      [
        ["a", 2],
        ["b", 1],
      ],
      new Set(ticked),
    ),
  ).toEqual(chips);
});

test("typeCounts: most frequent first, ties by name", () => {
  expect(typeCounts(log)).toEqual([
    ["events.iterate.com/account/personal-access-token-minted", 2],
    ["events.iterate.com/account/grant-ended", 1],
    ["events.iterate.com/itx/created", 1],
  ]);
});

test("rendererFor: an exact type wins over a prefix, the longest prefix wins over a shorter one, nothing else matches", () => {
  const exact = () => null;
  const account = () => null;
  const all = () => null;
  const renderers = {
    "events.iterate.com/account/personal-access-token-minted": exact,
    "events.iterate.com/account/*": account,
    "events.iterate.com/*": all,
  };
  expect(rendererFor(renderers, "events.iterate.com/account/personal-access-token-minted")).toBe(
    exact,
  );
  expect(rendererFor(renderers, "events.iterate.com/account/grant-ended")).toBe(account);
  expect(rendererFor(renderers, "events.iterate.com/itx/created")).toBe(all);
  expect(rendererFor(renderers, "custom/thing")).toBeUndefined();
  expect(rendererFor(undefined, "x")).toBeUndefined();
});

test("the short forms: the prefix dropped, the payload on one line and cut", () => {
  expect(shortEventType("events.iterate.com/account/personal-access-token-minted")).toBe(
    "account/personal-access-token-minted",
  );
  expect(payloadPreview({ a: 1 })).toBe('{"a":1}');
  expect(payloadPreview("x".repeat(200), 20)).toHaveLength(20);
  expect(payloadPreview(undefined)).toBe("");
});

// ── payloadSummary ──
test("an object reads as its fields, strings to their first line, nested values to their shape", () => {
  expect(
    payloadSummary({
      role: "system",
      content: "You are an agent.\nSecond line never shows",
      target: ["itx", "builtins"],
      config: { llm: {}, maxAutonomousTurns: 3, other: 1, more: 2 },
      n: 4,
    }),
  ).toBe(
    "role system · content You are an agent. · target [2] · config {llm, maxAutonomousTurns, other, …} · n 4",
  );
});
test("more than five fields end in an ellipsis; a long line is cut", () => {
  const wide = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`k${String(i)}`, i]));
  expect(payloadSummary(wide)).toBe("k0 0 · k1 1 · k2 2 · k3 3 · k4 4 · …");
  expect(payloadSummary({ a: "x".repeat(200) }, 30)).toHaveLength(30);
});
test("nothing, arrays and scalars", () => {
  expect(payloadSummary(undefined)).toBe("");
  expect(payloadSummary(null)).toBe("null");
  expect(payloadSummary([1, 2, 3])).toBe("3 items");
  expect(payloadSummary(42)).toBe("42");
});

function at(offset: number, type: string, payload?: unknown, actor?: string): ContextViewEvent {
  return {
    offset,
    type,
    createdAt: new Date(offset * 1000).toISOString(),
    payload,
    ...(actor && { source: { principal: { actor, email: `${actor}@example.com` } } }),
  };
}
