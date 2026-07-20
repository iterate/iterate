import { describe, expect, test, vi } from "vitest";
import { importGithubArtifact } from "./artifact-import.ts";

function fakeArtifacts() {
  return { import: vi.fn(async () => ({}) as ArtifactsCreateRepoResult) };
}

describe("importGithubArtifact", () => {
  test("imports the public GitHub URL with full history", async () => {
    const artifacts = fakeArtifacts();

    await importGithubArtifact(artifacts, {
      branch: "main",
      name: "project--repo",
      owner: "iterate",
      repo: "iterate",
    });

    expect(artifacts.import).toHaveBeenCalledWith({
      source: {
        branch: "main",
        url: "https://github.com/iterate/iterate.git",
      },
      target: { name: "project--repo" },
    });
  });

  test("accepts an existing deterministic target on retry", async () => {
    const artifacts = fakeArtifacts();
    artifacts.import.mockRejectedValueOnce(
      Object.assign(new Error("already exists"), { code: "ALREADY_EXISTS" }),
    );

    await expect(
      importGithubArtifact(artifacts, {
        branch: "main",
        name: "project--repo",
        owner: "iterate",
        repo: "iterate",
      }),
    ).resolves.toBeUndefined();
  });

  test("does not hide import failures", async () => {
    const artifacts = fakeArtifacts();
    artifacts.import.mockRejectedValueOnce(
      Object.assign(new Error("private repository"), { code: "REMOTE_AUTH_REQUIRED" }),
    );

    await expect(
      importGithubArtifact(artifacts, {
        branch: "main",
        name: "project--repo",
        owner: "iterate",
        repo: "private",
      }),
    ).rejects.toThrow("private repository");
  });
});
