import { describe, expect, it } from "vitest";
import { childAgentParentPath } from "./agent-paths.ts";

describe("childAgentParentPath", () => {
  it("resolves the immediate parent agent", () => {
    expect(childAgentParentPath("/agents/main/researcher")).toBe("/agents/main");
  });

  it("recurses through nested child agents", () => {
    expect(childAgentParentPath("/agents/a/b/c")).toBe("/agents/a/b");
  });

  it("works under thread agents (Slack/email/PR shapes)", () => {
    expect(childAgentParentPath("/agents/slack/main/C1/ts-1/helper")).toBe(
      "/agents/slack/main/C1/ts-1",
    );
    expect(childAgentParentPath("/agents/repos/root/pull-requests/7/tester")).toBe(
      "/agents/repos/root/pull-requests/7",
    );
    expect(childAgentParentPath("/agents/email/t1/helper")).toBe("/agents/email/t1");
    expect(childAgentParentPath("/agents/mcp/session-test/helper")).toBe(
      "/agents/mcp/session-test",
    );
    expect(childAgentParentPath("/agents/telegram/main/chat-1/helper")).toBe(
      "/agents/telegram/main/chat-1",
    );
    expect(childAgentParentPath("/agents/telegram/main/chat-1/topic-2/session-3/helper")).toBe(
      "/agents/telegram/main/chat-1/topic-2/session-3",
    );
  });

  it("allows multi-segment relative paths — each segment is an agent child", () => {
    expect(childAgentParentPath("/agents/main/team")).toBe("/agents/main");
    expect(childAgentParentPath("/agents/main/team/researcher")).toBe("/agents/main/team");
  });

  it("is null for ordinary agents and platform-owned route leaves", () => {
    expect(childAgentParentPath("/agents/main")).toBeNull();
    expect(childAgentParentPath("/repos/main/helper")).toBeNull();
    expect(childAgentParentPath("/agents/slack/main/C1/ts-1")).toBeNull();
    expect(childAgentParentPath("/agents/telegram/main/chat-1")).toBeNull();
    expect(childAgentParentPath("/agents/telegram/main/chat-1/topic-2")).toBeNull();
    expect(childAgentParentPath("/agents/telegram/main/chat-1/session-3")).toBeNull();
    expect(childAgentParentPath("/agents/telegram/main/chat-1/topic-2/session-3")).toBeNull();
    expect(childAgentParentPath("/agents/email/t1")).toBeNull();
    expect(childAgentParentPath("/agents/repos/root/pull-requests/7")).toBeNull();
    expect(childAgentParentPath("/agents/mcp/session-test")).toBeNull();
  });
});
