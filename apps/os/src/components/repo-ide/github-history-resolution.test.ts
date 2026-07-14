import { describe, expect, it } from "vitest";
import {
  githubHistoryMergeAgentPath,
  isGithubHistoryConflictError,
} from "./github-history-resolution.ts";

describe("isGithubHistoryConflictError", () => {
  it("matches sync, durable-object, and isomorphic-git non-FF wording", () => {
    expect(
      isGithubHistoryConflictError(
        new Error('syncFromGithub is not a fast-forward (GitHub says "diverged")'),
      ),
    ).toBe(true);
    expect(
      isGithubHistoryConflictError(
        new Error("GitHub push of main was rejected (non-fast-forward)"),
      ),
    ).toBe(true);
    expect(
      isGithubHistoryConflictError(
        new Error("Push rejected because it was not a simple fast-forward"),
      ),
    ).toBe(true);
  });

  it("ignores auth/network noise", () => {
    expect(isGithubHistoryConflictError(new Error("Bad credentials"))).toBe(false);
    expect(isGithubHistoryConflictError(new Error("unrelated transport failure"))).toBe(false);
  });
});

describe("githubHistoryMergeAgentPath", () => {
  it("is lowercase stream-safe", () => {
    const path = githubHistoryMergeAgentPath("/repos/Config");
    expect(path).toBe(path.toLowerCase());
    expect(path).toMatch(/^\/agents\/web\/github-merge-[a-z0-9-]+$/);
  });
});
