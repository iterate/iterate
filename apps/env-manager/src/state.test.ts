import { describe, expect, test } from "vitest";
import { AlchemyResources, EnvironmentResources } from "./state.ts";

const previewResources = {
  kind: "platform",
  authDbId: "auth-db",
  projectDirectoryKvId: "project-directory-kv",
  workerBuildCacheKvId: "worker-build-cache-kv",
  semaphoreDbId: "semaphore-db",
  filesBucketName: "files",
  sandboxesBucketName: "sandboxes",
} as const;

describe("Alchemy resource manifests", () => {
  test("requires the complete six-resource preview stack", () => {
    expect(EnvironmentResources.parse(previewResources)).toEqual(previewResources);
    expect(() =>
      EnvironmentResources.parse({
        ...previewResources,
        authDbId: undefined,
      }),
    ).toThrow();
  });

  test("keeps dev-global's Auth-only stack distinct", () => {
    expect(
      AlchemyResources.parse({
        kind: "auth",
        authDbId: "auth-dev-global-db",
      }),
    ).toEqual({
      kind: "auth",
      authDbId: "auth-dev-global-db",
    });
  });
});
