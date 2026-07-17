import { describe, expect, it } from "vitest";
import { agentPathIcon, agentPathLabel } from "~/lib/agent-roster-labels.ts";

describe("agentPathLabel", () => {
  it("strips /agents/ for ordinary agent paths", () => {
    expect(agentPathLabel("/agents/onboarding")).toEqual({ title: "onboarding" });
    expect(agentPathLabel("/agents/repos/config/pr/2012")).toEqual({
      title: "repos/config/pr/2012",
    });
    expect(agentPathLabel("/agents/slack/nustom/C123/ts-1")).toEqual({
      title: "slack/nustom/C123/ts-1",
    });
  });
});

describe("agentPathIcon", () => {
  it("infers channel icons from the path prefix", () => {
    expect(agentPathIcon("/agents/slack/x")).toBe("slack");
    expect(agentPathIcon("/agents/email/t1")).toBe("email");
    expect(agentPathIcon("/agents/telegram/bot")).toBe("telegram");
    expect(agentPathIcon("/agents/onboarding")).toBe("web");
    expect(agentPathIcon("/agents/repos/config/pr/7")).toBeUndefined();
    expect(agentPathIcon("/agents/misc")).toBeUndefined();
  });
});
