import { describe, expect, test } from "vitest";
import { agentWorkspacePath, normalizeWorkspacePath, workspaceBranchName } from "./utils.ts";

describe("normalizeWorkspacePath", () => {
  test("accepts /workspaces/ paths, arbitrarily nested", () => {
    expect(normalizeWorkspacePath("/workspaces/scratch")).toBe("/workspaces/scratch");
    expect(normalizeWorkspacePath("/workspaces/agents/demo")).toBe("/workspaces/agents/demo");
  });

  test("agent workspaces live at the agent path under /workspaces", () => {
    // This is `itx.workspace`: agentWorkspacePath maps the agent's own path
    // under the domain prefix, in lockstep with agentSandboxPath.
    expect(agentWorkspacePath("/agents/demo")).toBe("/workspaces/agents/demo");
    // Slack thread agents nest a dotted timestamp — must stay in lockstep.
    expect(agentWorkspacePath("/agents/slack/C123/ts-1738000000.123456")).toBe(
      "/workspaces/agents/slack/C123/ts-1738000000.123456",
    );
  });

  test("accepts any path the agent Durable Object can tolerate (codec-safe)", () => {
    expect(agentWorkspacePath("/agents/foo@bar")).toBe("/workspaces/agents/foo@bar");
  });

  test("rejects paths outside /workspaces/ and codec-unstable paths", () => {
    expect(() => normalizeWorkspacePath("/workspaces")).toThrow(/workspace paths live under/);
    expect(() => normalizeWorkspacePath("/agents/demo")).toThrow(/workspace paths live under/);
    expect(() => normalizeWorkspacePath("/workspaces/a b")).toThrow(/stable Durable Object path/);
  });
});

describe("workspaceBranchName", () => {
  test("the branch is the workspace path minus the leading slash", () => {
    expect(workspaceBranchName("/workspaces/agents/demo")).toBe("workspaces/agents/demo");
    expect(workspaceBranchName("/workspaces/agents/slack/C123/ts-1738000000.123456")).toBe(
      "workspaces/agents/slack/C123/ts-1738000000.123456",
    );
  });

  test("sanitizes git-refname-illegal sequences", () => {
    // ~ ^ : * [ survive the URL-based name codec but git refuses them in refnames.
    expect(workspaceBranchName("/workspaces/agents/a~b^c:d*e[f")).toBe(
      "workspaces/agents/a-b-c-d-e-f",
    );
    expect(workspaceBranchName("/workspaces/agents/ends.lock")).toBe("workspaces/agents/ends-lock");
    // A trailing dot is illegal in a ref component.
    expect(workspaceBranchName("/workspaces/agents/v1.")).toBe("workspaces/agents/v1-");
  });
});
