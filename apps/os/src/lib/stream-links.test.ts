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

  it("accepts GitHub agent paths that encode the link fingerprint with g~", () => {
    // Production agent streams for pull requests live at
    // /agents/repos/g~<sha256hex>/pull-requests/<n> — the tilde is part of the
    // durable identity (see github-agent-utils). The agent roster on the
    // project shell links every status row through StreamPath.parse; rejecting
    // ~ crashes /projects/<slug> for any project with a linked GitHub repo.
    const raw =
      "/agents/repos/g~e8fa7f072e4aa206b600dd33a5eed6c49199f677f3826282a56515a8bef2aeb8/pull-requests/1998";
    const path = StreamPath.parse(raw);
    expect(path).toBe(raw);
    expect(streamPathParent(path)).toBe(
      "/agents/repos/g~e8fa7f072e4aa206b600dd33a5eed6c49199f677f3826282a56515a8bef2aeb8/pull-requests",
    );
    expect(streamPathAncestors(path).at(-1)).toBe(path);
    expect(streamPathFromSplat(path.slice(1))).toBe(path);
    expect(streamPathToSplat(path)).toBe(path.slice(1));
  });

  it("rejects segments with characters outside the path alphabet", () => {
    expect(() => StreamPath.parse("/agents/with space")).toThrow();
    expect(() => StreamPath.parse("/agents/Upper")).toThrow();
    expect(() => StreamPath.parse("/agents/has.dot")).toThrow();
  });
});
