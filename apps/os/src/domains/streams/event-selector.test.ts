// EventSelector: the one filter dialect every lane speaks. These tests pin the
// schema's configure-time rejections, the compiled matcher's semantics
// (exact-`true` conditions, "*" wildcard, intersection), and the compile cache.

import { describe, expect, it, test } from "vitest";
import { compileEventSelector, compileJsonataExpression, EventSelector } from "./event-selector.ts";
import type { StreamEvent } from "./schemas.ts";

function evt(type: string, payload?: Record<string, unknown>): StreamEvent {
  return {
    type,
    offset: 1,
    createdAt: "2026-07-08T00:00:00.000Z",
    path: "/t",
    ...(payload === undefined ? {} : { payload }),
  };
}

describe("EventSelector schema", () => {
  test.for([
    { name: "empty object (matches everything)", input: {}, ok: true },
    { name: "eventTypes list", input: { eventTypes: ["a"] }, ok: true },
    { name: "wildcard entry", input: { eventTypes: ["*"] }, ok: true },
    { name: "condition expression", input: { condition: "payload.x = 1" }, ok: true },
    { name: "both fields", input: { eventTypes: ["a"], condition: "payload.x = 1" }, ok: true },
    // A subscription that can never match anything is a configure-time mistake.
    { name: "empty eventTypes list", input: { eventTypes: [] }, ok: false },
    { name: "blank event type", input: { eventTypes: ["   "] }, ok: false },
    { name: "blank condition", input: { condition: "   " }, ok: false },
    { name: "empty condition", input: { condition: "" }, ok: false },
  ])("$name -> valid: $ok", ({ input, ok }) => {
    expect(EventSelector.safeParse(input).success).toBe(ok);
  });
});

describe("compileEventSelector", () => {
  it("an undefined selector matches everything", () => {
    const selector = compileEventSelector(undefined);
    expect(selector.matchesAll).toBe(true);
    expect(selector.matches(evt("a"))).toBe(true);
    expect(selector.matches(evt("b", { anything: 1 }))).toBe(true);
  });

  it("an empty selector object matches everything", () => {
    const selector = compileEventSelector({});
    expect(selector.matchesAll).toBe(true);
    expect(selector.matches(evt("a"))).toBe(true);
  });

  it("eventTypes filters by exact type", () => {
    const selector = compileEventSelector({ eventTypes: ["a", "b"] });
    expect(selector.matchesAll).toBe(false);
    expect(selector.matches(evt("a"))).toBe(true);
    expect(selector.matches(evt("b"))).toBe(true);
    expect(selector.matches(evt("c"))).toBe(false);
    expect(selector.matches(evt("a-prefix-mismatch"))).toBe(false);
  });

  it("canonicalizes semantically equal selectors for aligned projection reuse", () => {
    const first = compileEventSelector({
      eventTypes: ["projection-b", "projection-a", "projection-a"],
      condition: "payload.projection = true",
    });
    const reordered = compileEventSelector({
      eventTypes: ["projection-a", "projection-b"],
      condition: "payload.projection = true",
    });
    const different = compileEventSelector({
      eventTypes: ["projection-a", "projection-b"],
      condition: "payload.projection = false",
    });

    expect(reordered).toBe(first);
    expect(different).not.toBe(first);
    expect(compileEventSelector({ eventTypes: ["projection-a", "*"] })).toBe(
      compileEventSelector(undefined),
    );
  });

  it('"*" anywhere in eventTypes means all types', () => {
    const wildcard = compileEventSelector({ eventTypes: ["*"] });
    const mixed = compileEventSelector({ eventTypes: ["a", "*"] });
    expect(wildcard.matchesAll).toBe(true);
    expect(mixed.matchesAll).toBe(true);
    expect(wildcard.matches(evt("anything"))).toBe(true);
    expect(mixed.matches(evt("b"))).toBe(true);
  });

  it("a condition must evaluate to exactly `true` — truthy is not enough", () => {
    const truthy = compileEventSelector({ condition: "payload.count" });
    expect(truthy.matchesAll).toBe(false);
    expect(truthy.matches(evt("a", { count: 1 }))).toBe(false); // 1 is truthy, not `true`
    expect(truthy.matches(evt("a", { count: "yes" }))).toBe(false);

    const boolean = compileEventSelector({ condition: "payload.enabled" });
    expect(boolean.matches(evt("a", { enabled: true }))).toBe(true);
    expect(boolean.matches(evt("a", { enabled: false }))).toBe(false);
    expect(boolean.matches(evt("a", {}))).toBe(false); // absent field -> undefined

    const comparison = compileEventSelector({ condition: 'payload.repo = "acme/widgets"' });
    expect(comparison.matches(evt("a", { repo: "acme/widgets" }))).toBe(true);
    expect(comparison.matches(evt("a", { repo: "acme/other" }))).toBe(false);
  });

  it("condition and eventTypes intersect: both must pass", () => {
    const selector = compileEventSelector({
      eventTypes: ["a"],
      condition: "payload.flag = true",
    });
    expect(selector.matches(evt("a", { flag: true }))).toBe(true);
    expect(selector.matches(evt("b", { flag: true }))).toBe(false); // wrong type
    expect(selector.matches(evt("a", { flag: false }))).toBe(false); // condition false
    expect(selector.matches(evt("a"))).toBe(false); // condition undefined
  });

  it("throws on an unparseable condition — the configure-time validation gate", () => {
    expect(() => compileEventSelector({ condition: "(((" })).toThrow();
    expect(() => compileEventSelector({ condition: "payload.x =" })).toThrow();
  });

  test.for(["$random()", "$shuffle([true, false])[0]", "$now()", "$millis()", '$eval("true")'])(
    "rejects nondeterministic selector condition %s",
    (condition) => {
      expect(() => compileEventSelector({ condition })).toThrow(/nondeterministic/);
    },
  );
});

describe("compileJsonataExpression", () => {
  it("caches: compiling the same string twice returns the same instance", () => {
    const first = compileJsonataExpression("payload.cachedExpression = 1");
    const second = compileJsonataExpression("payload.cachedExpression = 1");
    expect(second).toBe(first);
  });

  it("different strings compile to different instances", () => {
    expect(compileJsonataExpression("payload.a = 1")).not.toBe(
      compileJsonataExpression("payload.a = 2"),
    );
  });

  it("throws on parse errors instead of caching them", () => {
    expect(() => compileJsonataExpression("]")).toThrow();
  });
});
