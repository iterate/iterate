import { describe, expect, it } from "vitest";
import {
  StreamPath,
  streamPathAncestors,
  streamPathFromSplat,
  streamPathParent,
  streamPathToSplat,
} from "./stream-links.ts";

describe("StreamPath", () => {
  it("accepts the empty root and ordinary kebab segments", () => {
    expect(StreamPath.parse("/")).toBe("/");
    expect(StreamPath.parse("/agents")).toBe("/agents");
    expect(StreamPath.parse("/agents/slack/main/c123/ts-111-222")).toBe(
      "/agents/slack/main/c123/ts-111-222",
    );
  });

  it("round-trips a userspace pull-request agent path", () => {
    const raw = "/agents/repos/config/pr/1998";
    const path = StreamPath.parse(raw);
    expect(path).toBe(raw);
    expect(streamPathParent(path)).toBe("/agents/repos/config/pr");
    expect(streamPathAncestors(path).at(-1)).toBe(path);
    expect(streamPathFromSplat(path.slice(1))).toBe(path);
    expect(streamPathToSplat(path)).toBe(path.slice(1));
  });

  it("rejects segments with characters outside the path alphabet", () => {
    expect(() => StreamPath.parse("/agents/with space")).toThrow();
    expect(() => StreamPath.parse("/agents/Upper")).toThrow();
    expect(() => StreamPath.parse("/agents/has.dot")).toThrow();
    expect(() => StreamPath.parse("/agents/repos/bad~identity/pr/7")).toThrow();
  });
});
