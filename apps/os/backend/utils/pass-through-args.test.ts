import { describe, expect, test } from "vitest";
import { mergePassThroughArgs } from "./pass-through-args.ts";

describe("mergePassThroughArgs", () => {
  describe("null/undefined passThroughArgs", () => {
    test("returns payload when passThroughArgs is null", () => {
      const payload = { foo: "bar", baz: 42 };
      expect(mergePassThroughArgs(null, payload)).toEqual(payload);
    });

    test("returns payload when passThroughArgs is undefined", () => {
      const payload = { foo: "bar", baz: 42 };
      expect(mergePassThroughArgs(undefined, payload)).toEqual(payload);
    });

    test("works with array payload when passThroughArgs is null", () => {
      const payload = [1, 2, 3];
      expect(mergePassThroughArgs(null, payload)).toEqual(payload);
    });

    test("works with primitive payload when passThroughArgs is null", () => {
      expect(mergePassThroughArgs(null, "hello")).toBe("hello");
      expect(mergePassThroughArgs(null, 42)).toBe(42);
      expect(mergePassThroughArgs(null, true)).toBe(true);
    });
  });

  describe("object merging", () => {
    test("merges two objects with non-overlapping keys", () => {
      const passThroughArgs = { foo: "bar" };
      const payload = { baz: "qux" };
      expect(mergePassThroughArgs(passThroughArgs, payload)).toEqual({
        baz: "qux",
        foo: "bar",
      });
    });

    test("passThroughArgs overrides payload for overlapping keys", () => {
      const passThroughArgs = { foo: "override", extra: "value" };
      const payload = { foo: "original", baz: "qux" };
      expect(mergePassThroughArgs(passThroughArgs, payload)).toEqual({
        foo: "override",
        baz: "qux",
        extra: "value",
      });
    });

    test("handles nested objects without deep merging", () => {
      const passThroughArgs = { nested: { foo: "bar" } };
      const payload = { nested: { baz: "qux" }, other: "value" };
      expect(mergePassThroughArgs(passThroughArgs, payload)).toEqual({
        nested: { foo: "bar" }, // passThroughArgs completely replaces nested
        other: "value",
      });
    });

    test("handles empty objects", () => {
      expect(mergePassThroughArgs({}, { foo: "bar" })).toEqual({ foo: "bar" });
      expect(mergePassThroughArgs({ foo: "bar" }, {})).toEqual({ foo: "bar" });
      expect(mergePassThroughArgs({}, {})).toEqual({});
    });
  });

  describe("array merging", () => {
    test("merges arrays element by element", () => {
      const passThroughArgs = [1, 2];
      const payload = [3, 4, 5];
      expect(mergePassThroughArgs(passThroughArgs, payload)).toEqual([1, 2, 5]);
    });

    test("handles passThroughArgs longer than payload", () => {
      const passThroughArgs = [1, 2, 3, 4];
      const payload = [5, 6];
      expect(mergePassThroughArgs(passThroughArgs, payload)).toEqual([1, 2, 3, 4]);
    });

    test("handles payload longer than passThroughArgs", () => {
      const passThroughArgs = [1];
      const payload = [2, 3, 4, 5];
      expect(mergePassThroughArgs(passThroughArgs, payload)).toEqual([1, 3, 4, 5]);
    });

    test("handles empty arrays", () => {
      expect(mergePassThroughArgs([], [1, 2, 3])).toEqual([1, 2, 3]);
      expect(mergePassThroughArgs([1, 2, 3], [])).toEqual([1, 2, 3]);
      expect(mergePassThroughArgs([], [])).toEqual([]);
    });

    test("handles arrays with mixed types", () => {
      const passThroughArgs = [1, "two", { three: 3 }];
      const payload = ["one", 2, null, true];
      expect(mergePassThroughArgs(passThroughArgs, payload)).toEqual([
        1,
        "two",
        { three: 3 },
        true,
      ]);
    });
  });

  describe("error cases", () => {
    test("throws when passThroughArgs is object and payload is array", () => {
      expect(() => mergePassThroughArgs({ foo: "bar" }, [1, 2, 3])).toThrowError(
        /Cannot merge passThroughArgs of type "object" with payload of type "array"/,
      );
    });

    test("throws when passThroughArgs is array and payload is object", () => {
      expect(() => mergePassThroughArgs([1, 2, 3], { foo: "bar" })).toThrowError(
        /Cannot merge passThroughArgs of type "array" with payload of type "object"/,
      );
    });

    test("throws when passThroughArgs is primitive", () => {
      expect(() => mergePassThroughArgs("string", { foo: "bar" })).toThrowError(
        /Cannot merge passThroughArgs of type "string" with payload of type "object"/,
      );

      expect(() => mergePassThroughArgs(42, [1, 2, 3])).toThrowError(
        /Cannot merge passThroughArgs of type "number" with payload of type "array"/,
      );

      expect(() => mergePassThroughArgs(true, "hello")).toThrowError(
        /Cannot merge passThroughArgs of type "boolean" with payload of type "string"/,
      );
    });

    test("throws when payload is null", () => {
      expect(() => mergePassThroughArgs({ foo: "bar" }, null)).toThrowError(
        /Cannot merge passThroughArgs of type "object" with payload of type "null"/,
      );
    });

    test("throws when passThroughArgs is object and payload is primitive", () => {
      expect(() => mergePassThroughArgs({ foo: "bar" }, "string")).toThrowError(
        /Cannot merge passThroughArgs of type "object" with payload of type "string"/,
      );

      expect(() => mergePassThroughArgs({ foo: "bar" }, 42)).toThrowError(
        /Cannot merge passThroughArgs of type "object" with payload of type "number"/,
      );
    });
  });
});
