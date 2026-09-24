// The context view's pure halves: filtering the log, counting its types, matching a renderer by
// exact type or the most specific prefix, and the row's short forms.
import { expect, test } from "vitest";
import {
  filterEvents,
  payloadPreview,
  payloadSummary,
  shortEventType,
  typeCounts,
  type ContextViewFilter,
} from "./filters.tsx";
import { rendererFor, type ContextViewEvent } from "./types.tsx";

const EMPTY_FILTER: ContextViewFilter = { query: "", types: new Set() };

const log = [
  at(1, "events.iterate.com/stream/created", { path: "/" }),
  at(
    2,
    "events.iterate.com/account/grant-minted",
    { grantId: "grant_a", name: "laptop" },
    "user_1",
  ),
  at(3, "events.iterate.com/account/grant-ended", { grantId: "grant_a" }, "user_2"),
  at(4, "events.iterate.com/account/grant-minted", { grantId: "grant_b", name: "phone" }, "user_1"),
];

// ── filterEvents ──
test("no filter shows everything; types narrow to the set; the query searches type and payload; an actor narrows to theirs", () => {
  expect(filterEvents(log, EMPTY_FILTER)).toHaveLength(4);
  expect(
    filterEvents(log, {
      query: "",
      types: new Set(["events.iterate.com/account/grant-minted"]),
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

test("typeCounts: most frequent first, ties by name", () => {
  expect(typeCounts(log)).toEqual([
    ["events.iterate.com/account/grant-minted", 2],
    ["events.iterate.com/account/grant-ended", 1],
    ["events.iterate.com/stream/created", 1],
  ]);
});

test("rendererFor: an exact type wins over a prefix, the longest prefix wins over a shorter one, nothing else matches", () => {
  const exact = () => null;
  const account = () => null;
  const all = () => null;
  const renderers = {
    "events.iterate.com/account/grant-minted": exact,
    "events.iterate.com/account/*": account,
    "events.iterate.com/*": all,
  };
  expect(rendererFor(renderers, "events.iterate.com/account/grant-minted")).toBe(exact);
  expect(rendererFor(renderers, "events.iterate.com/account/grant-ended")).toBe(account);
  expect(rendererFor(renderers, "events.iterate.com/stream/created")).toBe(all);
  expect(rendererFor(renderers, "custom/thing")).toBeUndefined();
  expect(rendererFor(undefined, "x")).toBeUndefined();
});

test("the short forms: the prefix dropped, the payload on one line and cut", () => {
  expect(shortEventType("events.iterate.com/account/grant-minted")).toBe("account/grant-minted");
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
