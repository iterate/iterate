import { describe, expect, test } from "vitest";
import {
  agentWorkspacePath,
  normalizeWorkspaceMountKeys,
  normalizeWorkspacePath,
  workspaceCreationEvents,
} from "./utils.ts";

describe("workspaceCreationEvents", () => {
  test("builds the created/configured/subscription batch with stable identity keys", () => {
    const first = workspaceCreationEvents({
      mounts: { "/cfg": { policy: "read-only", repoPath: "/repos/config" } },
      path: "/workspaces/example",
      projectId: "prj_test",
    });
    const retryWithDifferentConfig = workspaceCreationEvents({
      mounts: { "/": { policy: "read-only", repoPath: "/repos/config" } },
      path: "/workspaces/example",
      projectId: "prj_test",
    });

    expect(first.map((event) => event.type)).toEqual([
      "events.iterate.com/workspace/created",
      "events.iterate.com/workspace/configured",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(first.map((event) => event.idempotencyKey)).toEqual(
      retryWithDifferentConfig.map((event) => event.idempotencyKey),
    );
    expect(first[1]?.payload).toEqual({
      config: {
        mounts: {
          "/cfg": { policy: "read-only", repoPath: "/repos/config" },
        },
      },
    });
  });
});

describe("normalizeWorkspacePath", () => {
  test("accepts /workspaces/ paths, arbitrarily nested", () => {
    expect(normalizeWorkspacePath("/workspaces/scratch")).toBe("/workspaces/scratch");
    expect(normalizeWorkspacePath("/workspaces/agents/demo")).toBe("/workspaces/agents/demo");
  });

  test("there is no root workspace — the bare prefix and '/' are rejected", () => {
    expect(() => normalizeWorkspacePath("/")).toThrow(/no root workspace/);
    expect(() => normalizeWorkspacePath("/workspaces")).toThrow(/no root workspace/);
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

describe("normalizeWorkspaceMountKeys", () => {
  test("normalizes mount points and repo paths", () => {
    expect(
      normalizeWorkspaceMountKeys({
        "/config/": { policy: "commit-to-main", repoPath: "repos/config" },
      }),
    ).toEqual({ "/config": { policy: "commit-to-main", repoPath: "/repos/config" } });
  });

  test("rejects .git segments, colliding spellings, and non-repo repoPaths", () => {
    expect(() =>
      normalizeWorkspaceMountKeys({ "/a/.git": { policy: "read-only", repoPath: "/repos/a" } }),
    ).toThrow(/reserved .git segment/);
    expect(() =>
      normalizeWorkspaceMountKeys({
        "/a": { policy: "read-only", repoPath: "/repos/a" },
        "/a/": { policy: "read-only", repoPath: "/repos/b" },
      }),
    ).toThrow(/duplicate mount path/);
    expect(() =>
      normalizeWorkspaceMountKeys({ "/a": { policy: "read-only", repoPath: "/secrets/a" } }),
    ).toThrow(/must name a \/repos\/\*\* stream/);
  });

  test("passes null (unmount) and repoPath-less patch values through", () => {
    expect(normalizeWorkspaceMountKeys({ "/a": null })).toEqual({ "/a": null });
    expect(normalizeWorkspaceMountKeys({ "/a": { policy: "read-only" } })).toEqual({
      "/a": { policy: "read-only" },
    });
  });
});
