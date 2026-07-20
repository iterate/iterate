import { describe, expect, it } from "vitest";
import {
  assertInstallationRepoCanBeCreated,
  githubRepoCreateRequest,
  type InstallationRepo,
} from "./github-installation-repos.ts";

const repo: InstallationRepo = {
  defaultBranch: "main",
  fullName: "iterate/iterate",
  name: "iterate",
  owner: "iterate",
  private: false,
  pushedAt: "2026-07-20T00:00:00Z",
};

describe("assertInstallationRepoCanBeCreated", () => {
  it("accepts a repository with main history", () => {
    expect(() => assertInstallationRepoCanBeCreated(repo)).not.toThrow();
  });

  it("rejects an empty repository before requesting creation", () => {
    expect(() => assertInstallationRepoCanBeCreated({ ...repo, pushedAt: null })).toThrow(
      "has no commits yet",
    );
  });

  it("rejects an unsupported default branch before requesting creation", () => {
    expect(() => assertInstallationRepoCanBeCreated({ ...repo, defaultBranch: "develop" })).toThrow(
      "default branch is main",
    );
  });
});

describe("githubRepoCreateRequest", () => {
  it("keeps public wizard imports shallow", () => {
    expect(githubRepoCreateRequest(repo, "install-1")).toEqual({
      connection: "install-1",
      depth: 1,
      owner: "iterate",
      repo: "iterate",
      type: "github-public",
    });
  });

  it("uses the private depth-one transfer mode for private repos", () => {
    expect(githubRepoCreateRequest({ ...repo, private: true }, "install-1")).toEqual({
      connection: "install-1",
      owner: "iterate",
      repo: "iterate",
      type: "github-private",
    });
  });
});
