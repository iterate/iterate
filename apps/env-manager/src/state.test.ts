import { describe, expect, test } from "vitest";
import {
  AlchemyResources,
  assertEnvironmentDestroyAllowed,
  EnvironmentResources,
  parsePersistedEnvironmentState,
  recoverInterruptedEnvironmentState,
} from "./state.ts";

const previewResources = {
  kind: "platform",
  stage: "preview_18",
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
        stage: "dev_global",
        authDbId: "auth-dev-global-db",
      }),
    ).toEqual({
      kind: "auth",
      stage: "dev_global",
      authDbId: "auth-dev-global-db",
    });
  });
});

describe("durable environment lifecycle", () => {
  test("requires a browser session at the production destroy boundary", () => {
    expect(() =>
      assertEnvironmentDestroyAllowed({
        browserSession: false,
        confirmation: "prd",
        stage: "prd",
      }),
    ).toThrow("authenticated browser session");
    expect(() =>
      assertEnvironmentDestroyAllowed({
        browserSession: false,
        confirmation: "preview_18",
        stage: "preview_18",
      }),
    ).not.toThrow();
  });

  test("keeps lifecycle operations available when persisted display state is invalid", () => {
    expect(parsePersistedEnvironmentState('{"obsolete":true}', "preview_18")).toMatchObject({
      stage: "preview_18",
      lifecycle: "failed",
      progress: [],
      lastError: expect.stringContaining("lifecycle state is invalid"),
    });
  });

  test("turns an operation interrupted by eviction or deployment into a durable failure", () => {
    expect(
      recoverInterruptedEnvironmentState(
        {
          stage: "preview_18",
          lifecycle: "destroying",
          operationStartedAt: "2026-07-30T12:00:00.000Z",
          progress: [],
        },
        "2026-07-30T12:01:00.000Z",
      ),
    ).toEqual({
      stage: "preview_18",
      lifecycle: "failed",
      operationStartedAt: "2026-07-30T12:00:00.000Z",
      operationFinishedAt: "2026-07-30T12:01:00.000Z",
      lastError: "Environment manager restarted while destroying; retry the operation.",
      progress: [],
    });
  });
});
