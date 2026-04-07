import { describe, expect, test } from "vitest";
import { StreamPath } from "@iterate-com/events-contract";
import { getRelativeStreamPath } from "./stream-path-relative.ts";

describe("getRelativeStreamPath", () => {
  test("shows descendants relative to the root stream", () => {
    expect(
      getRelativeStreamPath({
        basePath: "/",
        targetPath: StreamPath.parse("/banana/apple/strawberry"),
      }),
    ).toBe("./banana/apple/strawberry");
  });

  test("shows direct children relative to a nested parent stream", () => {
    expect(
      getRelativeStreamPath({
        basePath: StreamPath.parse("/banana/apple"),
        targetPath: StreamPath.parse("/banana/apple/strawberry"),
      }),
    ).toBe("./strawberry");
  });

  test("shows deeper descendants relative to a nested parent stream", () => {
    expect(
      getRelativeStreamPath({
        basePath: StreamPath.parse("/banana"),
        targetPath: StreamPath.parse("/banana/apple/strawberry"),
      }),
    ).toBe("./apple/strawberry");
  });

  test("falls back to the absolute path when the target is not a descendant", () => {
    expect(
      getRelativeStreamPath({
        basePath: StreamPath.parse("/banana"),
        targetPath: StreamPath.parse("/mango"),
      }),
    ).toBe("/mango");
  });
});
