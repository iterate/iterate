import { describe, expect, test, vi } from "vitest";
import {
  artifactSourceMatchesGithub,
  importPublicGithubSnapshotToArtifact,
  publicGithubRemoteUrl,
  type GithubArtifactImportRecord,
} from "./github-artifact-import.ts";

function artifactError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("public GitHub Artifact imports", () => {
  test("builds a credential-free canonical remote", () => {
    expect(publicGithubRemoteUrl(" iterate ", " iterate ")).toBe(
      "https://github.com/iterate/iterate.git",
    );
    expect(() => publicGithubRemoteUrl("iterate@token", "iterate")).toThrow(/URL-safe/);
  });

  test("recognizes the documented and HTTPS Artifact source forms", () => {
    expect(artifactSourceMatchesGithub("github:iterate/iterate", "iterate", "iterate")).toBe(true);
    expect(
      artifactSourceMatchesGithub("https://github.com/Iterate/Iterate.git", "iterate", "iterate"),
    ).toBe(true);
    expect(artifactSourceMatchesGithub("github:other/iterate", "iterate", "iterate")).toBe(false);
    expect(artifactSourceMatchesGithub(null, "iterate", "iterate")).toBe(false);
  });

  test("records intent before importing and records the returned identity", async () => {
    const records: GithubArtifactImportRecord[] = [];
    const artifacts = {
      get: vi.fn(async () => {
        throw artifactError("NOT_FOUND");
      }),
      import: vi.fn(async () => ({ id: "artifact-1" })),
    } as unknown as Artifacts;

    await importPublicGithubSnapshotToArtifact({
      artifacts,
      name: "repo-name",
      owner: "iterate",
      prior: undefined,
      repo: "iterate",
      save: (record) => records.push({ ...record }),
    });

    expect(records).toEqual([
      { artifactId: null, sourceUrl: "https://github.com/iterate/iterate.git" },
      { artifactId: "artifact-1", sourceUrl: "https://github.com/iterate/iterate.git" },
    ]);
    expect(artifacts.import).toHaveBeenCalledWith({
      source: {
        branch: "main",
        depth: 1,
        url: "https://github.com/iterate/iterate.git",
      },
      target: { name: "repo-name" },
    });
  });

  test("recovers a lost response only when the existing Artifact source matches", async () => {
    const save = vi.fn();
    const get = vi.fn(async () => ({ id: "artifact-1", source: "github:iterate/iterate" }));
    const artifacts = {
      get,
      import: vi.fn(async () => {
        throw artifactError("ALREADY_EXISTS");
      }),
    } as unknown as Artifacts;
    const retry = {
      artifacts,
      name: "repo-name",
      owner: "iterate",
      prior: { artifactId: null, sourceUrl: "https://github.com/iterate/iterate.git" },
      repo: "iterate",
      save,
    };

    await importPublicGithubSnapshotToArtifact(retry);
    expect(save).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      sourceUrl: "https://github.com/iterate/iterate.git",
    });

    get.mockResolvedValueOnce({ id: "artifact-2", source: "github:other/repo" });
    await expect(importPublicGithubSnapshotToArtifact(retry)).rejects.toThrow(
      /source does not match/,
    );
  });
});
