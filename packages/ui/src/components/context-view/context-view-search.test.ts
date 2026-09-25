// The view's URL state: a bad value is an absent key, never an error; the filter reads from it.
import { expect, test } from "vitest";
import { ContextViewState, contextViewFilterOf } from "./context-view-search.ts";

// ── ContextViewState ──
test("a valid search parses as is", () => {
  expect(
    ContextViewState.parse({
      mode: "raw",
      q: "grant",
      types: ["events.iterate.com/account/personal-access-token-minted"],
      actor: "user_1",
      from: 3,
      to: 9,
      event: 12,
      processors: true,
      filter: true,
    }),
  ).toEqual({
    mode: "raw",
    q: "grant",
    types: ["events.iterate.com/account/personal-access-token-minted"],
    actor: "user_1",
    from: 3,
    to: 9,
    event: 12,
    processors: true,
    filter: true,
  });
});
test("a hand-edited value drops its key and nothing else", () => {
  expect(
    ContextViewState.parse({
      mode: "loud",
      event: "abc",
      processors: "yes",
      types: "x",
      from: -1,
      to: 2.5,
      q: "ok",
    }),
  ).toEqual({ q: "ok" });
  expect(ContextViewState.parse({})).toEqual({});
});

test("contextViewFilterOf", () => {
  expect(contextViewFilterOf({})).toEqual({ query: "", types: new Set(), actor: undefined });
  expect(contextViewFilterOf({ q: " a ", types: ["t"], actor: "u", from: 1, to: 5 })).toEqual({
    query: " a ",
    types: new Set(["t"]),
    actor: "u",
    from: 1,
    to: 5,
  });
});
