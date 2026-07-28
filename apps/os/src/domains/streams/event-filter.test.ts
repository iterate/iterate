// EventFilter: the one filter shape every event receiver uses. These tests pin the
// schema's configure-time rejections, the compiled matcher's semantics
// (exact-`true` conditions, "*" wildcard, intersection), and the compile cache.

import { describe, expect, it, test } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { compileEventFilter, compileJsonataExpression, EventFilter } from "./event-filter.ts";

function evt(type: string, payload?: Record<string, unknown>): StreamEvent {
  return {
    type,
    offset: 1,
    createdAt: "2026-07-08T00:00:00.000Z",
    path: "/t",
    ...(payload === undefined ? {} : { payload }),
  };
}

describe("EventFilter schema", () => {
  test.for([
    { name: "empty object (matches everything)", input: {}, ok: true },
    { name: "eventTypes list", input: { eventTypes: ["a"] }, ok: true },
    { name: "wildcard entry", input: { eventTypes: ["*"] }, ok: true },
    { name: "condition expression", input: { jsonataCondition: "payload.x = 1" }, ok: true },
    {
      name: "both fields",
      input: { eventTypes: ["a"], jsonataCondition: "payload.x = 1" },
      ok: true,
    },
    // A subscription that can never match anything is a configure-time mistake.
    { name: "empty eventTypes list", input: { eventTypes: [] }, ok: false },
    { name: "blank event type", input: { eventTypes: ["   "] }, ok: false },
    { name: "blank condition", input: { jsonataCondition: "   " }, ok: false },
    { name: "empty condition", input: { jsonataCondition: "" }, ok: false },
  ])("$name -> valid: $ok", ({ input, ok }) => {
    expect(EventFilter.safeParse(input).success).toBe(ok);
  });
});

describe("compileEventFilter", () => {
  it("an undefined filter matches everything", () => {
    const filter = compileEventFilter(undefined);
    expect(filter.matches(evt("a"))).toBe(true);
    expect(filter.matches(evt("b", { anything: 1 }))).toBe(true);
  });

  it("an empty filter object matches everything", () => {
    const filter = compileEventFilter({});
    expect(filter.matches(evt("a"))).toBe(true);
  });

  it("eventTypes filters by exact type", () => {
    const filter = compileEventFilter({ eventTypes: ["a", "b"] });
    expect(filter.matches(evt("a"))).toBe(true);
    expect(filter.matches(evt("b"))).toBe(true);
    expect(filter.matches(evt("c"))).toBe(false);
    expect(filter.matches(evt("a-prefix-mismatch"))).toBe(false);
  });

  it('"*" anywhere in eventTypes means all types', () => {
    expect(compileEventFilter({ eventTypes: ["*"] }).matches(evt("anything"))).toBe(true);
    expect(compileEventFilter({ eventTypes: ["a", "*"] }).matches(evt("b"))).toBe(true);
  });

  it("a condition must evaluate to exactly `true` — truthy is not enough", () => {
    const truthy = compileEventFilter({ jsonataCondition: "payload.count" });
    expect(truthy.matches(evt("a", { count: 1 }))).toBe(false); // 1 is truthy, not `true`
    expect(truthy.matches(evt("a", { count: "yes" }))).toBe(false);

    const boolean = compileEventFilter({ jsonataCondition: "payload.enabled" });
    expect(boolean.matches(evt("a", { enabled: true }))).toBe(true);
    expect(boolean.matches(evt("a", { enabled: false }))).toBe(false);
    expect(boolean.matches(evt("a", {}))).toBe(false); // absent field -> undefined

    const comparison = compileEventFilter({ jsonataCondition: 'payload.repo = "acme/widgets"' });
    expect(comparison.matches(evt("a", { repo: "acme/widgets" }))).toBe(true);
    expect(comparison.matches(evt("a", { repo: "acme/other" }))).toBe(false);
  });

  it("condition and eventTypes intersect: both must pass", () => {
    const filter = compileEventFilter({
      eventTypes: ["a"],
      jsonataCondition: "payload.flag = true",
    });
    expect(filter.matches(evt("a", { flag: true }))).toBe(true);
    expect(filter.matches(evt("b", { flag: true }))).toBe(false); // wrong type
    expect(filter.matches(evt("a", { flag: false }))).toBe(false); // condition false
    expect(filter.matches(evt("a"))).toBe(false); // condition undefined
  });

  it("throws on an unparseable condition — the configure-time validation gate", () => {
    expect(() => compileEventFilter({ jsonataCondition: "(((" })).toThrow();
    expect(() => compileEventFilter({ jsonataCondition: "payload.x =" })).toThrow();
  });
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

  it("turns JSONata's plain parser object into a useful Error instead of caching it", () => {
    let thrown: unknown;
    try {
      compileJsonataExpression("payload.(((");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      message:
        'invalid JSONata expression (S0203, position 11): Expected ")" before end of expression',
    });
  });
});
