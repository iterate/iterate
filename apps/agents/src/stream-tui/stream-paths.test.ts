import { StreamPath } from "@iterate-com/events-contract";
import { describe, expect, test } from "vitest";
import { formatRelativeStreamPath, resolveStreamPath } from "./stream-paths.ts";

describe("resolveStreamPath", () => {
  test("defaults to the current stream and resolves dot-relative children", () => {
    const currentStreamPath = StreamPath.parse("/team/alpha");

    expect(resolveStreamPath({ currentStreamPath })).toBe("/team/alpha");
    expect(resolveStreamPath({ currentStreamPath, streamPath: "child" })).toBe("/team/alpha/child");
    expect(resolveStreamPath({ currentStreamPath, streamPath: "../beta" })).toBe("/team/beta");
    expect(resolveStreamPath({ currentStreamPath, streamPath: "/absolute" })).toBe("/absolute");
  });

  test("rejects relative paths without a current stream", () => {
    expect(() => resolveStreamPath({ streamPath: "child" })).toThrow(
      "Relative stream path requires a current stream.",
    );
  });
});

describe("formatRelativeStreamPath", () => {
  test("formats sibling and child paths relative to the current stream", () => {
    const currentStreamPath = StreamPath.parse("/team/alpha");

    expect(
      formatRelativeStreamPath({
        currentStreamPath,
        streamPath: StreamPath.parse("/team/alpha/child"),
      }),
    ).toBe("child");
    expect(
      formatRelativeStreamPath({
        currentStreamPath,
        streamPath: StreamPath.parse("/team/beta"),
      }),
    ).toBe("../beta");
  });
});
