import { describe, expect, it } from "vitest";
import {
  GITHUB_HISTORY_RESOLUTION_OPTIONS,
  GITHUB_UI_FORCE_PULL_DEPTH,
  githubHistoryMergeAgentInstructions,
  githubHistoryMergeAgentPath,
  isGithubHistoryConflictError,
} from "./github-history-resolution.ts";

describe("isGithubHistoryConflictError", () => {
  it("recognizes syncFromGithub non-fast-forward wording", () => {
    expect(
      isGithubHistoryConflictError(
        new Error(
          "syncFromGithub is not a fast-forward (GitHub says \"diverged\" relative to this repo's head abc). Pass force: true to discard local-only history and adopt GitHub's head.",
        ),
      ),
    ).toBe(true);
  });

  it("recognizes push non-fast-forward wording from the durable object", () => {
    expect(
      isGithubHistoryConflictError(
        new Error(
          "GitHub push of main was rejected (non-fast-forward means GitHub has commits this repo does not; use syncFromGithub() to adopt them or pushToGithub({ force: true }) to overwrite): {}",
        ),
      ),
    ).toBe(true);
  });

  it("recognizes isomorphic-git PushRejectedError wording", () => {
    // Thrown before RepoDurableObject reaches its custom pushed.ok message.
    expect(
      isGithubHistoryConflictError(
        new Error("Push rejected because it was not a simple fast-forward"),
      ),
    ).toBe(true);
  });

  it("does not treat auth or network failures as history conflicts", () => {
    expect(isGithubHistoryConflictError(new Error("Bad credentials"))).toBe(false);
    expect(isGithubHistoryConflictError(new Error("ENOTFOUND api.github.com"))).toBe(false);
    // Loose "unrelated" alone used to false-positive; require the quoted status form.
    expect(isGithubHistoryConflictError(new Error("unrelated transport failure"))).toBe(false);
  });
});

describe("github history resolution options", () => {
  it("lists pull, push, and agent without a static default flag", () => {
    expect(GITHUB_HISTORY_RESOLUTION_OPTIONS.map((option) => option.value)).toEqual([
      "pull",
      "push",
      "agent",
    ]);
    expect(GITHUB_UI_FORCE_PULL_DEPTH).toBeGreaterThan(0);
  });
});

describe("githubHistoryMergeAgentPath", () => {
  it("stays under /agents/web and uses only lowercase stream-safe segments", () => {
    const path = githubHistoryMergeAgentPath("/repos/Config-Repo");
    expect(path.startsWith("/agents/web/github-merge-config-repo-")).toBe(true);
    // StreamPath rejects uppercase (ISO's "T" used to break navigation).
    expect(path).toBe(path.toLowerCase());
    expect(path).toMatch(/^\/agents\/web\/github-merge-[a-z0-9-]+$/);
  });
});

describe("githubHistoryMergeAgentInstructions", () => {
  it("names both the project path and the GitHub repository", () => {
    const text = githubHistoryMergeAgentInstructions({
      owner: "iterate",
      repo: "config",
      repoPath: "/repos/config",
    });
    expect(text).toContain("/repos/config");
    expect(text).toContain("iterate/config");
    expect(text).toContain("sandboxes.create");
    // Publishable sequence: force-pull base, then commitFiles, then mirror push.
    expect(text).toContain("syncFromGithub({ force: true");
    expect(text).toContain("commitFiles");
    expect(text).toContain("pushToGithub()");
  });
});
