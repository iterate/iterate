import { describe, expect, it } from "vitest";
import { subagentParentPath } from "./subagent-paths.ts";

describe("subagentParentPath", () => {
  it("resolves the immediate parent agent", () => {
    expect(subagentParentPath("/agents/main/subagents/researcher")).toBe("/agents/main");
  });

  it("recurses: the parent of a sub-subagent is the subagent", () => {
    expect(subagentParentPath("/agents/a/subagents/b/subagents/c")).toBe("/agents/a/subagents/b");
  });

  it("works under thread agents (Slack/email/PR shapes)", () => {
    expect(subagentParentPath("/agents/slack/main/C1/ts-1/subagents/helper")).toBe(
      "/agents/slack/main/C1/ts-1",
    );
    expect(subagentParentPath("/agents/repos/root/pull-requests/7/subagents/tester")).toBe(
      "/agents/repos/root/pull-requests/7",
    );
  });

  it("allows multi-segment relative paths — a subagent address is a path, not a name", () => {
    expect(subagentParentPath("/agents/main/subagents/team/researcher")).toBe("/agents/main");
  });

  it("is null for ordinary agents and near-misses", () => {
    expect(subagentParentPath("/agents/main")).toBeNull();
    // The subagents folder stream itself is not a subagent.
    expect(subagentParentPath("/agents/main/subagents")).toBeNull();
    // A "parent" that is the /agents directory, not an agent.
    expect(subagentParentPath("/agents/subagents/x")).toBeNull();
    expect(subagentParentPath("/repos/main/subagents/x")).toBeNull();
  });
});
