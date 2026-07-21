import { expect, test, vi } from "vitest";
import { getOrCreateArtifact } from "./artifact-creation.ts";

test("an existing seeded repo does not repeat first-push setup", async () => {
  const beforeFirstPush = vi.fn(async () => {
    throw new Error("Cloudflare subscriptions API is unavailable");
  });
  const artifacts = {
    create: vi.fn(async () => {
      throw artifactError("ALREADY_EXISTS");
    }),
    get: vi.fn(async () => ({ lastPushAt: "2026-07-20T12:00:00.000Z" })),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    beforeFirstPush,
    defaultBranch: "main",
  });

  expect(result).toEqual({ created: false, lastPushAt: "2026-07-20T12:00:00.000Z" });
  expect(beforeFirstPush).not.toHaveBeenCalled();
});

test("a new repo completes first-push setup before creation returns", async () => {
  const beforeFirstPush = vi.fn(async () => {});
  const artifacts = {
    create: vi.fn(async () => {}),
    get: vi.fn(),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    beforeFirstPush,
    defaultBranch: "trunk",
  });

  expect(result).toEqual({ created: true, lastPushAt: null });
  expect(artifacts.create).toHaveBeenCalledExactlyOnceWith("project-repo", {
    setDefaultBranch: "trunk",
  });
  expect(beforeFirstPush).toHaveBeenCalledOnce();
  expect(artifacts.get).not.toHaveBeenCalled();
});

test("an unseeded existing repo completes first-push setup during recovery", async () => {
  const beforeFirstPush = vi.fn(async () => {});
  const artifacts = {
    create: vi.fn(async () => {
      throw artifactError("ALREADY_EXISTS");
    }),
    get: vi.fn(async () => ({ lastPushAt: null })),
  };

  const result = await getOrCreateArtifact(artifacts, "project-repo", {
    beforeFirstPush,
    defaultBranch: "main",
  });

  expect(result).toEqual({ created: false, lastPushAt: null });
  expect(beforeFirstPush).toHaveBeenCalledOnce();
});

function artifactError(code: string) {
  return Object.assign(new Error(code), { code });
}
