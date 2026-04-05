import { describe, expect, test } from "vitest";
import { getRelativeDescendantStreamPath } from "~/lib/stream-path-relative.ts";

describe("getRelativeDescendantStreamPath", () => {
  test("renders descendants relative to the root stream", () => {
    expect(getRelativeDescendantStreamPath("/", "/strawberry")).toBe("./strawberry");
    expect(getRelativeDescendantStreamPath("/", "/banana/apple")).toBe("./banana/apple");
  });

  test("renders descendants relative to a nested current stream", () => {
    expect(getRelativeDescendantStreamPath("/banana/apple", "/banana/apple/strawberry")).toBe(
      "./strawberry",
    );
    expect(getRelativeDescendantStreamPath("/banana/apple", "/banana/apple/strawberry/seed")).toBe(
      "./strawberry/seed",
    );
  });

  test("falls back to the absolute path outside the current subtree", () => {
    expect(getRelativeDescendantStreamPath("/banana/apple", "/banana/pear")).toBe("/banana/pear");
  });
});
