import { expect, test, vi } from "vitest";
import { getOrCreateArtifact } from "./artifact-creation.ts";

test("an existing seeded repo reports its last push", async () => {
  const artifacts = {
    create: vi.fn(async () => {
      throw artifactError("ALREADY_EXISTS");
    }),
    get: vi.fn(async () => ({ lastPushAt: "2026-07-20T12:00:00.000Z" })),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    defaultBranch: "main",
  });

  expect(result).toEqual({ created: false, lastPushAt: "2026-07-20T12:00:00.000Z" });
});

test("a new repo is created with its default branch", async () => {
  const artifacts = {
    create: vi.fn(async () => {}),
    get: vi.fn(),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    defaultBranch: "trunk",
  });

  expect(result).toEqual({ created: true, lastPushAt: null });
  expect(artifacts.create).toHaveBeenCalledExactlyOnceWith("project-repo", {
    setDefaultBranch: "trunk",
  });
  expect(artifacts.get).not.toHaveBeenCalled();
});

test("an unseeded existing repo remains eligible for recovery", async () => {
  const artifacts = {
    create: vi.fn(async () => {
      throw artifactError("ALREADY_EXISTS");
    }),
    get: vi.fn(async () => ({ lastPushAt: null })),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    defaultBranch: "main",
  });

  expect(result).toEqual({ created: false, lastPushAt: null });
});

function artifactError(code: string) {
  return Object.assign(new Error(code), { code });
}
