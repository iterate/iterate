import { describe, expect, test } from "vitest";
import {
  ROOT_WORKSPACE_PATH,
  agentWorkspacePath,
  isRootWorkspacePath,
  normalizeWorkspacePath,
  workspaceBranchName,
} from "./utils.ts";

describe("normalizeWorkspacePath", () => {
  test("accepts /workspaces/ paths, arbitrarily nested", () => {
    expect(normalizeWorkspacePath("/workspaces/scratch")).toBe("/workspaces/scratch");
    expect(normalizeWorkspacePath("/workspaces/agents/demo")).toBe("/workspaces/agents/demo");
  });

  test('"/" is the root workspace, and the bare prefix is its identity', () => {
    expect(normalizeWorkspacePath("/")).toBe(ROOT_WORKSPACE_PATH);
    expect(normalizeWorkspacePath("/workspaces")).toBe(ROOT_WORKSPACE_PATH);
    expect(isRootWorkspacePath(normalizeWorkspacePath("/"))).toBe(true);
    expect(isRootWorkspacePath(normalizeWorkspacePath("/workspaces/agents/demo"))).toBe(false);
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

  test("sanitizes git-refname-illegal sequences, with a disambiguating suffix", () => {
    // ~ : * [ survive the URL-based name codec but git refuses them in
    // refnames. (^ is deliberately absent: some Node versions percent-encode
    // it in URL paths, so it cannot round-trip the codec everywhere.)
    expect(workspaceBranchName("/workspaces/agents/a~b:c*d[e")).toMatch(
      /^workspaces\/agents\/a-b-c-d-e-[0-9a-f]{8}$/,
    );
    expect(workspaceBranchName("/workspaces/agents/ends.lock")).toMatch(
      /^workspaces\/agents\/ends-lock-[0-9a-f]{8}$/,
    );
    // Sanitized names carry a hash of the RAW path, so near-miss paths that
    // sanitize identically still get distinct branches.
    expect(workspaceBranchName("/workspaces/agents/a~b")).not.toBe(
      workspaceBranchName("/workspaces/agents/a:b"),
    );
  });
});
