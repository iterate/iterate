import { describe, expect, test, vi } from "vitest";
import { importGithubArtifact } from "./artifact-import.ts";

function fakeArtifacts() {
  return {
    get: vi.fn(async () => ({}) as ArtifactsRepo),
    import: vi.fn(async () => ({}) as ArtifactsCreateRepoResult),
  };
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
    expect(artifacts.get).toHaveBeenCalledWith("project--repo");
  });

  test("passes an explicit shallow depth to Artifacts", async () => {
    const artifacts = fakeArtifacts();

    await importGithubArtifact(artifacts, {
      branch: "main",
      depth: 1,
      name: "project--repo",
      owner: "iterate",
      repo: "iterate",
    });

    expect(artifacts.import).toHaveBeenCalledWith({
      source: {
        branch: "main",
        depth: 1,
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
    expect(artifacts.get).toHaveBeenCalledWith("project--repo");
  });

  test("does not accept an existing target that is not ready", async () => {
    const artifacts = fakeArtifacts();
    artifacts.import.mockRejectedValueOnce(
      Object.assign(new Error("already exists"), { code: "ALREADY_EXISTS" }),
    );
    artifacts.get.mockRejectedValueOnce(
      Object.assign(new Error("still importing"), { code: "IMPORT_IN_PROGRESS" }),
    );

    await expect(
      importGithubArtifact(artifacts, {
        branch: "main",
        name: "project--repo",
        owner: "iterate",
        repo: "iterate",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_IN_PROGRESS" });
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
