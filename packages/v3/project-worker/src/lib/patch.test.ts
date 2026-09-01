// Executable spec for the live-state delta format. The one invariant that matters:
// applyPatch(a, diff(a, b)) always deep-equals b — every shape below proves it, then asserts
// the op shapes we promised (append fast path, wholesale array replace, key remove).
import { describe, expect, test } from "vitest";
import { applyPatch, diff } from "./patch.ts";

const roundtrip = (a: unknown, b: unknown) => {
  const ops = diff(a, b);
  expect(ops, `diff(${JSON.stringify(a)}, ${JSON.stringify(b)})`).toBeDefined();
  expect(applyPatch(a, ops!)).toEqual(b);
  return ops!;
};

describe("diff + applyPatch", () => {
  test("deep-equal values diff to undefined (the don't-emit signal)", () => {
    expect(diff({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBeUndefined();
    expect(diff(3, 3)).toBeUndefined();
  });

  test("scalar and key changes are replace/add/remove ops", () => {
    expect(roundtrip({ count: 1 }, { count: 2 })).toEqual([
      { op: "replace", path: "/count", value: 2 },
    ]);
    expect(roundtrip({ a: 1 }, { a: 1, b: 2 })).toEqual([{ op: "add", path: "/b", value: 2 }]);
    expect(roundtrip({ a: 1, b: 2 }, { a: 1 })).toEqual([{ op: "remove", path: "/b" }]);
  });

  test("the chat-log fast path: pure array append becomes `add …/-` ops", () => {
    const ops = roundtrip({ messages: [{ t: "hi" }] }, { messages: [{ t: "hi" }, { t: "again" }] });
    expect(ops).toEqual([{ op: "add", path: "/messages/-", value: { t: "again" } }]);
  });

  test("tail truncation becomes remove ops; middle divergence replaces wholesale", () => {
    expect(roundtrip({ xs: [1, 2, 3] }, { xs: [1] })).toEqual([
      { op: "remove", path: "/xs/2" },
      { op: "remove", path: "/xs/1" },
    ]);
    expect(roundtrip({ xs: [1, 2, 3] }, { xs: [1, 9, 3] })).toEqual([
      { op: "replace", path: "/xs", value: [1, 9, 3] },
    ]);
  });

  test("nested recursion, type flips, and root replacement", () => {
    roundtrip({ a: { b: { c: 1 } } }, { a: { b: { c: 2, d: 3 } } });
    roundtrip({ a: [1] }, { a: { was: "array" } });
    expect(roundtrip(1, { now: "object" })).toEqual([
      { op: "replace", path: "", value: { now: "object" } },
    ]);
  });

  test("JSON-Pointer escaping for keys containing / and ~", () => {
    const ops = roundtrip({ "a/b": 1, "c~d": 2 }, { "a/b": 9, "c~d": 8 });
    expect(ops.map((o) => o.path).sort()).toEqual(["/a~1b", "/c~0d"]);
  });

  test("applyPatch never mutates its input", () => {
    const a = { messages: [{ t: "hi" }] };
    applyPatch(a, [{ op: "add", path: "/messages/-", value: { t: "x" } }]);
    expect(a.messages).toHaveLength(1);
  });

  test("keys shadowing Object.prototype members diff by OWN presence, not the chain", () => {
    expect(roundtrip({ toString: "hi" }, {})).toEqual([{ op: "remove", path: "/toString" }]);
    expect(roundtrip({}, { toString: "x" })).toEqual([
      { op: "add", path: "/toString", value: "x" },
    ]);
    roundtrip({ constructor: "a", keep: 1 }, { keep: 1 });
  });

  test("diff sees JSON semantics: undefined keys vanish, Dates diff as their ISO strings", () => {
    // a key "becoming undefined" is a REMOVAL on the wire, never a value-less op
    expect(diff({ a: 1, b: 2 }, { a: 1, b: undefined })).toEqual([{ op: "remove", path: "/b" }]);
    expect(diff({ a: undefined }, { a: undefined })).toBeUndefined();
    // a changed Date emits a real patch (structural equal() alone would call them identical)
    const ops = diff({ at: new Date(0) }, { at: new Date(1000) });
    expect(ops).toEqual([{ op: "replace", path: "/at", value: new Date(1000).toISOString() }]);
    // sparse-array holes normalize to null instead of producing holes in the ops array
    const sparse = [1];
    sparse[3] = 4;
    expect(applyPatch([1], diff([1], sparse)!)).toEqual([1, null, null, 4]);
  });

  test("applyPatch cannot touch prototypes (patches arrive over the wire)", () => {
    expect(() => applyPatch({}, [{ op: "add", path: "/__proto__/polluted", value: true }])).toThrow(
      /__proto__/,
    );
    // traversal is own-property-only: an inherited member never resolves as a container
    expect(() =>
      applyPatch({}, [{ op: "add", path: "/constructor/prototype/polluted", value: true }]),
    ).toThrow(/missing path/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
