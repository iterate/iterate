import { describe, expect, it } from "vitest";
import { applyPatch, diff } from "iterate/live-state-diff";

/** applyPatch(prev, diff(prev, next)) must reconstruct `next` exactly. */
function roundTrip(prev: unknown, next: unknown) {
  const patch = diff(prev, next);
  return patch === undefined ? prev : applyPatch(prev, patch);
}

describe("diff", () => {
  it("returns undefined when nothing changed", () => {
    expect(diff(1, 1)).toBeUndefined();
    expect(diff("a", "a")).toBeUndefined();
    const shared = { a: 1 };
    expect(diff({ x: shared }, { x: shared })).toBeUndefined();
    expect(diff({ a: 1, b: 2 }, { a: 1, b: 2 })).toBeUndefined();
  });

  it("replaces primitives and type changes wholesale", () => {
    expect(diff(1, 2)).toEqual({ set: 2 });
    expect(diff("a", "b")).toEqual({ set: "b" });
    expect(diff({ a: 1 }, 5)).toEqual({ set: 5 });
    expect(diff(5, { a: 1 })).toEqual({ set: { a: 1 } });
  });

  it("treats arrays as opaque leaves (no positional diff)", () => {
    expect(diff([1, 2, 3], [1, 9, 3])).toEqual({ set: [1, 9, 3] });
    expect(diff({ xs: [1, 2] }, { xs: [1, 2, 3] })).toEqual({ fields: { xs: { set: [1, 2, 3] } } });
  });

  it("emits only the changed keys of a plain object", () => {
    expect(diff({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({ fields: { b: { set: 3 } } });
  });

  it("records added and removed keys", () => {
    expect(diff({ a: 1 }, { a: 1, b: 2 })).toEqual({ fields: { b: { set: 2 } } });
    expect(diff({ a: 1, b: 2 }, { a: 1 })).toEqual({ drop: ["b"] });
    expect(diff({ a: 1, b: 2 }, { a: 1, b: undefined })).toEqual({ drop: ["b"] });
  });

  it("short-circuits unchanged sub-trees by reference", () => {
    const untouched = { deep: { value: 1 } };
    const patch = diff({ a: 1, big: untouched }, { a: 2, big: untouched });
    // `big` never appears — it kept its reference, so the diff never descended.
    expect(patch).toEqual({ fields: { a: { set: 2 } } });
  });

  it("treats class instances (Date/Map/Set) as opaque leaves, not keyed maps", () => {
    // Descending would diff own enumerable keys — a Date has NONE, so two
    // different Dates would read as "unchanged" and the subscriber would stay
    // stale forever. They must replace wholesale instead.
    const d1 = new Date("2026-01-01T00:00:00Z");
    const d2 = new Date("2026-02-02T00:00:00Z");
    expect(diff(d1, d2)).toEqual({ set: d2 });
    expect(diff({ at: d1 }, { at: d2 })).toEqual({ fields: { at: { set: d2 } } });
    expect(diff(new Map([["a", 1]]), new Map([["a", 2]]))).toEqual({ set: new Map([["a", 2]]) });
    expect(diff(new Set([1]), new Set([2]))).toEqual({ set: new Set([2]) });
    // Identical references still short-circuit.
    expect(diff({ at: d1 }, { at: d1 })).toBeUndefined();
  });

  it("produces a minimal patch for one changed row of a keyed map", () => {
    const prevRow = { path: "/a", at: 1 };
    const prev = { rows: { "/a": prevRow, "/b": { path: "/b", at: 1 } } };
    const next = { rows: { "/a": prevRow, "/b": { path: "/b", at: 2 } } };
    expect(diff(prev, next)).toEqual({
      fields: { rows: { fields: { "/b": { fields: { at: { set: 2 } } } } } },
    });
  });
});

describe("applyPatch", () => {
  it("round-trips every shape back to next", () => {
    const cases: Array<[unknown, unknown]> = [
      [1, 2],
      ["a", "b"],
      [{ a: 1 }, { a: 2 }],
      [{ a: 1, b: 2 }, { a: 1 }],
      [{ a: 1 }, { a: 1, b: 2 }],
      [{ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }],
      [{ xs: [1, 2] }, { xs: [3] }],
      [{ a: 1 }, 5],
      [5, { a: 1 }],
      [
        { rows: { "/a": { at: 1 }, "/b": { at: 1 } } },
        { rows: { "/a": { at: 1 }, "/b": { at: 2 } } },
      ],
      // Class instances replace wholesale — the round-trip must land the NEW
      // instance, not silently keep the stale one.
      [{ at: new Date("2026-01-01T00:00:00Z") }, { at: new Date("2026-02-02T00:00:00Z") }],
      [{ m: new Map([["a", 1]]) }, { m: new Map([["a", 2]]) }],
      [{ s: new Set([1]) }, { s: new Set([1, 2]) }],
    ];
    for (const [prev, next] of cases) {
      expect(roundTrip(prev, next)).toEqual(next);
    }
  });

  it('handles "__proto__" as a data key — no prototype injection, no dropped field', () => {
    // `next[key] =` would SET THE PROTOTYPE for this key; applyPatch must
    // define an own property instead. Both directions matter: the field
    // round-trips like any other key, and a hostile patch cannot pollute
    // Object.prototype or the result's prototype chain.
    const withProtoKey = (value: unknown) =>
      Object.defineProperty({}, "__proto__", {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      }) as Record<string, unknown>;

    const prev = withProtoKey({ admin: false });
    const next = withProtoKey({ admin: true });
    const patch = diff(prev, next)!;
    // The patch must stay WIRE-SERIALIZABLE: capnweb accepts exactly
    // Object.prototype objects, so the fields bag can't be null-proto (that
    // variant shipped briefly and killed every push — the panel froze).
    if ("set" in patch) throw new Error("expected a fields patch, got a leaf replacement");
    expect(Object.getPrototypeOf(patch.fields)).toBe(Object.prototype);
    const applied = applyPatch(prev, patch) as Record<string, unknown>;
    expect(Object.hasOwn(applied, "__proto__")).toBe(true);
    expect(applied).toEqual(next);
    // The prototype chain stayed clean — nothing was injected.
    expect(Object.getPrototypeOf(applied)).toBe(Object.prototype);
    expect(({} as { admin?: boolean }).admin).toBeUndefined();

    // Removal direction: `"__proto__" in next` is true for EVERY object (the
    // inherited accessor), so an `in`-based presence check would never record
    // the drop and the stale field would survive the round-trip.
    const removed = applyPatch(prev, diff(prev, {})!) as Record<string, unknown>;
    expect(Object.hasOwn(removed, "__proto__")).toBe(false);
    expect(removed).toEqual({});

    // A hostile patch against a state that never had the key: still no pollution.
    const polluted = applyPatch({} as Record<string, unknown>, {
      fields: { ["__proto__"]: { set: { admin: true } } },
    });
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
  });

  it("preserves the identity of branches the patch did not touch", () => {
    const prev = { core: { offset: 1 }, index: { "/a": { at: 1 } } };
    const next = { core: { offset: 2 }, index: prev.index };
    const patch = diff(prev, next)!;
    const applied = applyPatch(prev, patch);
    // The client selector on `index` must be able to bail out: same reference.
    expect(applied.index).toBe(prev.index);
    // ...while the branch that actually changed is a fresh object.
    expect(applied.core).not.toBe(prev.core);
    expect(applied).toEqual(next);
  });

  it("keeps sibling rows identical when one row of a keyed map changes", () => {
    const prev = { "/a": { at: 1 }, "/b": { at: 1 } };
    const next = { "/a": { at: 1 }, "/b": { at: 2 } };
    const applied = applyPatch(prev, diff(prev, next)!);
    expect(applied["/a"]).toBe(prev["/a"]); // untouched row keeps identity
    expect(applied).toEqual(next);
  });
});
