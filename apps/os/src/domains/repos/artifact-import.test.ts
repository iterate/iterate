import { describe, expect, test, vi } from "vitest";
import { importGithubArtifact } from "./artifact-import.ts";

function fakeArtifacts() {
  return {
    get: vi.fn(async () => ({ name: "target" })),
    import: vi.fn(async () => ({ name: "target" })),
  } as unknown as Artifacts;
}

describe("importGithubArtifact", () => {
  test("imports a canonical public GitHub URL at the requested depth", async () => {
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
    expect(artifacts.get).not.toHaveBeenCalled();
  });

  test("accepts an existing deterministic target on recovery", async () => {
    const artifacts = fakeArtifacts();
    vi.mocked(artifacts.import).mockRejectedValueOnce(
      Object.assign(new Error("already exists"), { code: "ALREADY_EXISTS" }),
    );

    await importGithubArtifact(artifacts, {
      branch: "main",
      depth: 1,
      name: "project--repo",
      owner: "iterate",
      repo: "iterate",
    });

    expect(artifacts.get).toHaveBeenCalledWith("project--repo");
  });

  test("waits boundedly for an import already in progress", async () => {
    const artifacts = fakeArtifacts();
    const sleep = vi.fn(async () => undefined);
    vi.mocked(artifacts.import).mockRejectedValueOnce(
      Object.assign(new Error("import in progress"), { code: "IMPORT_IN_PROGRESS" }),
    );
    vi.mocked(artifacts.get)
      .mockRejectedValueOnce(
        Object.assign(new Error("import in progress"), { code: "IMPORT_IN_PROGRESS" }),
      )
      .mockResolvedValueOnce({ name: "target" } as never);

    await importGithubArtifact(
      artifacts,
      {
        branch: "main",
        depth: 1,
        name: "project--repo",
        owner: "iterate",
        repo: "iterate",
      },
      { pollAttempts: 2, pollIntervalMs: 7, sleep },
    );

    expect(artifacts.get).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7);
  });

  test("fails explicitly when an in-progress import never completes", async () => {
    const artifacts = fakeArtifacts();
    vi.mocked(artifacts.import).mockRejectedValueOnce(
      Object.assign(new Error("import in progress"), { code: "IMPORT_IN_PROGRESS" }),
    );
    vi.mocked(artifacts.get).mockRejectedValue(
      Object.assign(new Error("import in progress"), { code: "IMPORT_IN_PROGRESS" }),
    );

    await expect(
      importGithubArtifact(
        artifacts,
        {
          branch: "main",
          depth: 1,
          name: "project--repo",
          owner: "iterate",
          repo: "iterate",
        },
        { pollAttempts: 2, pollIntervalMs: 0, sleep: async () => undefined },
      ),
    ).rejects.toThrow("Timed out waiting for Cloudflare Artifacts");
    expect(artifacts.get).toHaveBeenCalledTimes(2);
  });

  test("does not hide import failures", async () => {
    const artifacts = fakeArtifacts();
    vi.mocked(artifacts.import).mockRejectedValueOnce(
      Object.assign(new Error("private repository"), { code: "REMOTE_AUTH_REQUIRED" }),
    );

    await expect(
      importGithubArtifact(artifacts, {
        branch: "main",
        depth: 1,
        name: "project--repo",
        owner: "iterate",
        repo: "private",
      }),
    ).rejects.toThrow("private repository");
    expect(artifacts.get).not.toHaveBeenCalled();
  });
});
