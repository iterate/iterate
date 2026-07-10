import { describe, expect, it } from "vitest";
import { resolveAgentPath } from "./utils.ts";

describe("resolveAgentPath", () => {
  it("passes absolute agent paths through", () => {
    expect(resolveAgentPath("/agents/main", undefined)).toBe("/agents/main");
    expect(resolveAgentPath("/agents/main", "/agents/other")).toBe("/agents/main");
  });

  it("resolves relative paths against the calling agent scope", () => {
    expect(resolveAgentPath("researcher", "/agents/main")).toBe("/agents/main/researcher");
    expect(resolveAgentPath("team/researcher", "/agents/main")).toBe(
      "/agents/main/team/researcher",
    );
  });

  it('".." climbs — a child agent reaches its parent with one segment', () => {
    expect(resolveAgentPath("..", "/agents/main/researcher")).toBe("/agents/main");
    expect(resolveAgentPath("..", "/agents/a/b/c")).toBe("/agents/a/b");
    expect(resolveAgentPath("../..", "/agents/a/b/c")).toBe("/agents/a");
    expect(resolveAgentPath("../sibling", "/agents/main/researcher")).toBe("/agents/main/sibling");
  });

  it('"." stays put', () => {
    expect(resolveAgentPath(".", "/agents/main")).toBe("/agents/main");
    expect(resolveAgentPath("./x", "/agents/main")).toBe("/agents/main/x");
  });

  it("climbing above /agents/ fails the agent-path guard", () => {
    expect(() => resolveAgentPath("../..", "/agents/main/researcher")).toThrow(
      /must start with "\/agents\/"/,
    );
  });

  it("rejects empty segments — messaging a typo must error, not birth a junk stream", () => {
    expect(() => resolveAgentPath("team//x", "/agents/main")).toThrow(
      /invalid relative agent path/,
    );
    expect(() => resolveAgentPath("team/x/", "/agents/main")).toThrow(
      /invalid relative agent path/,
    );
  });

  it("rejects relative paths without an agent scope to resolve against", () => {
    expect(() => resolveAgentPath("x", undefined)).toThrow(/needs an agent scope/);
    expect(() => resolveAgentPath("x", "/repos/config")).toThrow(/needs an agent scope/);
  });
});
