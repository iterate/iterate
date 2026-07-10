import { describe, expect, it } from "vitest";
import { subagentParentPath } from "./subagent-paths.ts";

describe("subagentParentPath", () => {
  it("resolves the immediate parent agent", () => {
    expect(subagentParentPath("/agents/main/researcher")).toBe("/agents/main");
  });

  it("recurses: the parent of a sub-subagent is the subagent", () => {
    expect(subagentParentPath("/agents/a/b/c")).toBe("/agents/a/b");
  });

  it("works under thread agents (Slack/email/PR shapes)", () => {
    expect(subagentParentPath("/agents/slack/main/C1/ts-1/helper")).toBe(
      "/agents/slack/main/C1/ts-1",
    );
    expect(subagentParentPath("/agents/repos/root/pull-requests/7/tester")).toBe(
      "/agents/repos/root/pull-requests/7",
    );
    expect(subagentParentPath("/agents/email/t1/helper")).toBe("/agents/email/t1");
    expect(subagentParentPath("/agents/mcp/session-test/helper")).toBe("/agents/mcp/session-test");
    expect(subagentParentPath("/agents/telegram/main/chat-1/helper")).toBe(
      "/agents/telegram/main/chat-1",
    );
    expect(subagentParentPath("/agents/telegram/main/chat-1/topic-2/session-3/helper")).toBe(
      "/agents/telegram/main/chat-1/topic-2/session-3",
    );
  });

  it("allows multi-segment relative paths — each segment is an agent child", () => {
    expect(subagentParentPath("/agents/main/team")).toBe("/agents/main");
    expect(subagentParentPath("/agents/main/team/researcher")).toBe("/agents/main/team");
  });

  it("is null for ordinary agents and platform-owned route leaves", () => {
    expect(subagentParentPath("/agents/main")).toBeNull();
    expect(subagentParentPath("/repos/main/helper")).toBeNull();
    expect(subagentParentPath("/agents/slack/main/C1/ts-1")).toBeNull();
    expect(subagentParentPath("/agents/telegram/main/chat-1")).toBeNull();
    expect(subagentParentPath("/agents/telegram/main/chat-1/topic-2")).toBeNull();
    expect(subagentParentPath("/agents/telegram/main/chat-1/session-3")).toBeNull();
    expect(subagentParentPath("/agents/telegram/main/chat-1/topic-2/session-3")).toBeNull();
    expect(subagentParentPath("/agents/email/t1")).toBeNull();
    expect(subagentParentPath("/agents/repos/root/pull-requests/7")).toBeNull();
    expect(subagentParentPath("/agents/mcp/session-test")).toBeNull();
  });
});
