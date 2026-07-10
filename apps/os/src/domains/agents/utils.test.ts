import { describe, expect, it } from "vitest";
import { resolveAgentPath } from "./utils.ts";

describe("resolveAgentPath", () => {
  it("passes absolute agent paths through", () => {
    expect(resolveAgentPath("/agents/main", undefined)).toBe("/agents/main");
    expect(resolveAgentPath("/agents/main", "/agents/other")).toBe("/agents/main");
  });

  it("resolves relative paths against the calling agent scope", () => {
    expect(resolveAgentPath("subagents/researcher", "/agents/main")).toBe(
      "/agents/main/subagents/researcher",
    );
    expect(resolveAgentPath("subagents/team/researcher", "/agents/main")).toBe(
      "/agents/main/subagents/team/researcher",
    );
  });

  it('".." climbs — a subagent reaches its parent via "../.."', () => {
    expect(resolveAgentPath("../..", "/agents/main/subagents/researcher")).toBe("/agents/main");
    expect(resolveAgentPath("../..", "/agents/a/subagents/b/subagents/c")).toBe(
      "/agents/a/subagents/b",
    );
    expect(resolveAgentPath("../../../..", "/agents/a/subagents/b/subagents/c")).toBe("/agents/a");
    expect(resolveAgentPath("../sibling", "/agents/main/subagents/researcher")).toBe(
      "/agents/main/subagents/sibling",
    );
  });

  it('"." stays put', () => {
    expect(resolveAgentPath(".", "/agents/main")).toBe("/agents/main");
    expect(resolveAgentPath("./subagents/x", "/agents/main")).toBe("/agents/main/subagents/x");
  });

  it("climbing above /agents/ fails the agent-path guard", () => {
    expect(() => resolveAgentPath("../../..", "/agents/main/subagents/researcher")).toThrow(
      /must start with "\/agents\/"/,
    );
  });

  it("rejects empty segments — messaging a typo must error, not birth a junk stream", () => {
    expect(() => resolveAgentPath("subagents//x", "/agents/main")).toThrow(
      /invalid relative agent path/,
    );
    expect(() => resolveAgentPath("subagents/x/", "/agents/main")).toThrow(
      /invalid relative agent path/,
    );
  });

  it("rejects relative paths without an agent scope to resolve against", () => {
    expect(() => resolveAgentPath("subagents/x", undefined)).toThrow(/needs an agent scope/);
    expect(() => resolveAgentPath("subagents/x", "/repos/config")).toThrow(/needs an agent scope/);
  });
});
