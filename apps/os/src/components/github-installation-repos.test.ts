import { describe, expect, it } from "vitest";
import {
  assertInstallationRepoCanBeCreated,
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
