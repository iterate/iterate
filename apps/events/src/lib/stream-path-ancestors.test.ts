import { describe, expect, test } from "vitest";
import { StreamPath } from "@iterate-com/events-contract";
import { getAncestorStreamPaths } from "./stream-path-ancestors.ts";

describe("getAncestorStreamPaths", () => {
  test("returns no ancestors for the root stream", () => {
    expect(getAncestorStreamPaths("/")).toEqual([]);
  });

  test("returns root-first ancestors and excludes the stream itself", () => {
    expect(getAncestorStreamPaths(StreamPath.parse("/alpha/bravo/charlie"))).toEqual([
      "/",
      StreamPath.parse("/alpha"),
      StreamPath.parse("/alpha/bravo"),
    ]);
  });
});
