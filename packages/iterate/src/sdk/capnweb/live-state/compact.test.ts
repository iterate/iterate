import { describe, expect, it } from "vitest";
import { applyCompactPatch, compactPatch } from "./compact.ts";
import { applyPatch, diff } from "./diff.ts";

describe("compact live-state codec", () => {
  it.each([
    [
      { z: 1, a: 2 },
      { z: 3, b: 4 },
    ],
    [
      { "0": 1, "+": 2, "#": 3, "": 4 },
      { "0": 8, "+": 9, "#": 10, "": 11 },
    ],
    [
      { absent: undefined, z: 1 },
      { absent: undefined, z: 2 },
    ],
    [[{ n: 1 }, { n: 2 }], [{ n: 3 }]],
    [[1], [1, { n: [2, 3] }]],
    [[1, 2], []],
    [{ value: null }, { value: { text: "new" } }],
    [{ value: { text: "old" } }, { value: [false, null, 4] }],
    [Object.fromEntries([["__proto__", { n: 1 }]]), Object.fromEntries([["__proto__", { n: 2 }]])],
    [{}, Object.fromEntries([["__proto__", { n: 2 }]])],
  ])("round-trips structural changes from %j to %j", (previous, next) => {
    const patch = compactPatch(previous, diff(previous, next)!);
    expect(applyCompactPatch(previous, patch)).toEqual(applyPatch(previous, diff(previous, next)!));
    // Both transports may change property insertion order and omit undefined.
    const baseline: unknown = JSON.parse(JSON.stringify(previous));
    expect(JSON.stringify(applyCompactPatch(baseline, patch))).toBe(JSON.stringify(next));
    expect(Object.getPrototypeOf(applyCompactPatch(previous, patch))).toBe(
      Object.getPrototypeOf(next),
    );
  });

  it("resolves all addresses against the baseline before fields are added or deleted", () => {
    const previous = { zebra: 1, middle: 2, apple: 3 };
    const next = { zebra: 4, aardvark: 5, middle: 6 };
    const patch = compactPatch(previous, diff(previous, next)!);
    expect(applyCompactPatch({ apple: 3, middle: 2, zebra: 1 }, patch)).toEqual(next);
  });

  it("appends bounded text, preserves surrogate pairs, and replaces edits or long strings", () => {
    const previous = "x".repeat(100) + "\ud83d";
    const patch = compactPatch(previous, { set: previous + "\ude80 next" });
    expect(patch).toEqual([101, "\ude80 next"]);
    expect(applyCompactPatch(previous, patch)).toBe("x".repeat(100) + "🚀 next");
    expect(compactPatch(previous, { set: "edited" })).toBe("edited");
    const long = "x".repeat(1_048_576);
    expect(compactPatch(long, { set: long + " next" })).toBe(long + " next");
  });

  it("retains sealed text and unrelated branches while a tail grows", () => {
    const sealed = { 0: "x".repeat(1024) };
    const untouched = { title: "same" };
    const previous = { groups: { 0: sealed, 1: { 0: "a".repeat(100) } }, untouched };
    const next = {
      ...previous,
      groups: { ...previous.groups, 1: { 0: "a".repeat(100) + " tail" } },
    };
    const result = applyCompactPatch(previous, compactPatch(previous, diff(previous, next)!));
    expect(result).toEqual(next);
    expect(result.groups[0]).toBe(sealed);
    expect(result.untouched).toBe(untouched);
  });

  it("rejects invalid addresses and append baselines instead of corrupting state", () => {
    expect(() => applyCompactPatch({ n: 1 }, { 1: 2 })).toThrow("address");
    expect(() => applyCompactPatch({ n: 1 }, { "01": 2 })).toThrow("address");
    expect(() => applyCompactPatch({ n: 1 }, { "+n": 2 })).toThrow("already exists");
    expect(() => applyCompactPatch({ n: 1 }, { "+missing": [] })).toThrow("delete a new field");
    expect(() => applyCompactPatch([1], { "#": -1 })).toThrow("length");
    expect(() => applyCompactPatch([1], { 1: 2 })).toThrow("address");
    expect(() => applyCompactPatch("old", [2, " append"])).toThrow("baseline");
  });

  it("matches structural diff across repeated dictionary edits and transport reordering", () => {
    let previous: Record<string, unknown> = {};
    for (let step = 0; step < 500; step++) {
      const next = {
        ...previous,
        [`key-${step % 13}`]: { text: "x".repeat(step % 100), rows: [step, true] },
      };
      if (step % 3 === 0) delete next[`key-${(step + 7) % 13}`];
      const patch = diff(previous, next)!;
      const reordered = Object.fromEntries(Object.entries(previous).reverse());
      expect(applyCompactPatch(reordered, compactPatch(previous, patch))).toEqual(next);
      previous = next;
    }
  });
});
