import { describe, expect, it } from "vitest";
import { agentPathIcon, agentPathLabel } from "~/lib/agent-roster-labels.ts";

describe("agentPathLabel", () => {
  it("labels PR conversational agents without the hashed repo id", () => {
    expect(
      agentPathLabel("/agents/repos/g~e8fa7f072e4aa206b600dd33a5eed6c49199f677/pull-requests/2012"),
    ).toEqual({
      title: "PR #2012",
      subtitle: "Pull request agent",
    });
  });

  it("labels iterate-review children with PR number and check id", () => {
    expect(
      agentPathLabel(
        "/agents/repos/g~e8fa7f072e4aa206b600dd33a5eed6c49199f677/pull-requests/2012/iterate-reviews/87331030759",
      ),
    ).toEqual({
      title: "PR #2012 review",
      subtitle: "Check 87331030759",
    });
  });

  it("strips /agents/ for ordinary agent paths", () => {
    expect(agentPathLabel("/agents/onboarding")).toEqual({ title: "onboarding" });
    expect(agentPathLabel("/agents/slack/nustom/C123/ts-1")).toEqual({
      title: "slack/nustom/C123/ts-1",
    });
  });
});

describe("agentPathIcon", () => {
  it("infers github for PR and review agents", () => {
    expect(agentPathIcon("/agents/repos/g~abc/pull-requests/7")).toBe("github");
    expect(agentPathIcon("/agents/repos/g~abc/pull-requests/7/iterate-reviews/99")).toBe("github");
  });

  it("infers channel icons from the path prefix", () => {
    expect(agentPathIcon("/agents/slack/x")).toBe("slack");
    expect(agentPathIcon("/agents/email/t1")).toBe("email");
    expect(agentPathIcon("/agents/telegram/bot")).toBe("telegram");
    expect(agentPathIcon("/agents/onboarding")).toBe("web");
    expect(agentPathIcon("/agents/misc")).toBeUndefined();
  });
});
