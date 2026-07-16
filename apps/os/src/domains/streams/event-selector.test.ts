// EventSelector: the one filter dialect every lane speaks. These tests pin the
// schema's configure-time rejections, the compiled matcher's semantics
// (exact-`true` conditions, "*" wildcard, intersection), and the compile cache.

import { describe, expect, it, test } from "vitest";
import type { StreamEvent } from "iterate/stream-events";
import { compileEventSelector, compileJsonataExpression, EventSelector } from "./event-selector.ts";

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
    expect(selector.matches(evt("a"))).toBe(true);
    expect(selector.matches(evt("b", { anything: 1 }))).toBe(true);
  });

  it("an empty selector object matches everything", () => {
    const selector = compileEventSelector({});
    expect(selector.matches(evt("a"))).toBe(true);
  });

  it("eventTypes filters by exact type", () => {
    const selector = compileEventSelector({ eventTypes: ["a", "b"] });
    expect(selector.matches(evt("a"))).toBe(true);
    expect(selector.matches(evt("b"))).toBe(true);
    expect(selector.matches(evt("c"))).toBe(false);
    expect(selector.matches(evt("a-prefix-mismatch"))).toBe(false);
  });

  it('"*" anywhere in eventTypes means all types', () => {
    expect(compileEventSelector({ eventTypes: ["*"] }).matches(evt("anything"))).toBe(true);
    expect(compileEventSelector({ eventTypes: ["a", "*"] }).matches(evt("b"))).toBe(true);
  });

  it("a condition must evaluate to exactly `true` — truthy is not enough", () => {
    const truthy = compileEventSelector({ condition: "payload.count" });
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
