import { describe, expect, it, vi } from "vitest";
import { replaceArtifactWithEmptyRepo } from "./artifact-replacement.ts";

function artifactsError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("replaceArtifactWithEmptyRepo", () => {
  it("waits for the acknowledged deletion to become visible before recreating the name", async () => {
    const calls: string[] = [];
    const artifacts = {
      create: vi.fn(async () => {
        calls.push("create");
        return {} as ArtifactsCreateRepoResult;
      }),
      delete: vi.fn(async () => {
        calls.push("delete");
        return true;
      }),
      get: vi
        .fn<Artifacts["get"]>()
        .mockImplementationOnce(async () => {
          calls.push("get:present");
          return {} as ArtifactsRepo;
        })
        .mockImplementationOnce(async () => {
          calls.push("get:missing");
          throw artifactsError("NOT_FOUND");
        }),
    };

    await replaceArtifactWithEmptyRepo(artifacts, "repo", {
      beforeDelete: () => {
        calls.push("invalidate");
      },
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    expect(calls).toEqual(["invalidate", "delete", "get:present", "get:missing", "create"]);
    expect(artifacts.create).toHaveBeenCalledWith("repo", { setDefaultBranch: "main" });
  });

  it("invalidates the caller's old-repository state even when deletion fails", async () => {
    const beforeDelete = vi.fn();
    const artifacts = {
      create: vi.fn(async () => ({}) as ArtifactsCreateRepoResult),
      delete: vi.fn(async () => {
        throw artifactsError("INTERNAL_ERROR");
      }),
      get: vi.fn<Artifacts["get"]>(),
    };

    await expect(
      replaceArtifactWithEmptyRepo(artifacts, "repo", { beforeDelete }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    expect(beforeDelete).toHaveBeenCalledOnce();
    expect(artifacts.create).not.toHaveBeenCalled();
  });

  it("creates immediately when the artifact was already absent", async () => {
    const artifacts = {
      create: vi.fn(async () => ({}) as ArtifactsCreateRepoResult),
      delete: vi.fn(async () => false),
      get: vi.fn<Artifacts["get"]>(),
    };

    await replaceArtifactWithEmptyRepo(artifacts, "repo");

    expect(artifacts.get).not.toHaveBeenCalled();
    expect(artifacts.create).toHaveBeenCalledOnce();
  });

  it("does not mask a real Artifacts read failure", async () => {
    const artifacts = {
      create: vi.fn(async () => ({}) as ArtifactsCreateRepoResult),
      delete: vi.fn(async () => true),
      get: vi.fn<Artifacts["get"]>(async () => {
        throw artifactsError("INTERNAL_ERROR");
      }),
    };

    await expect(
      replaceArtifactWithEmptyRepo(artifacts, "repo", { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(artifacts.create).not.toHaveBeenCalled();
  });

  it("refuses to recreate while deletion is still pending", async () => {
    const artifacts = {
      create: vi.fn(async () => ({}) as ArtifactsCreateRepoResult),
      delete: vi.fn(async () => true),
      get: vi.fn(async () => ({}) as ArtifactsRepo),
    };

    await expect(
      replaceArtifactWithEmptyRepo(artifacts, "repo", {
        pollAttempts: 2,
        pollIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow('Timed out waiting for Artifacts repository "repo" deletion');
    expect(artifacts.create).not.toHaveBeenCalled();
  });
});
