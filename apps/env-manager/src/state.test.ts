import { describe, expect, test } from "vitest";
import {
  AlchemyResources,
  assertEnvironmentDestroyAllowed,
  EnvironmentResources,
  parsePersistedEnvironmentState,
  persistedEnvironmentState,
  reconcileEnvironmentState,
  recoverInterruptedEnvironmentState,
  wasEnvironmentDestroyInterrupted,
  type PersistedEnvironmentState,
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

  test("persists lifecycle only and leaves resources in canonical Alchemy output", () => {
    expect(
      persistedEnvironmentState({
        stage: "preview_18",
        lifecycle: "ready",
        progress: [],
        resources: previewResources,
      }),
    ).toEqual({
      stage: "preview_18",
      lifecycle: "ready",
      progress: [],
    });
  });

  test("reconciles settled lifecycle against canonical Alchemy output", () => {
    expect(
      reconcileEnvironmentState(
        { stage: "preview_18", lifecycle: "empty", progress: [] },
        previewResources,
      ),
    ).toMatchObject({ lifecycle: "ready", resources: previewResources });
    expect(
      reconcileEnvironmentState(
        { stage: "preview_18", lifecycle: "ready", progress: [] },
        undefined,
      ),
    ).toEqual({ stage: "preview_18", lifecycle: "empty", progress: [] });
  });

  test("preserves an operation failure while projecting canonical resources", () => {
    expect(
      reconcileEnvironmentState(
        {
          stage: "preview_18",
          lifecycle: "failed",
          progress: [],
          lastError: "deploy failed",
        },
        previewResources,
      ),
    ).toMatchObject({
      lifecycle: "failed",
      lastError: "deploy failed",
      resources: previewResources,
    });
  });

  test("turns an operation interrupted by eviction or deployment into a durable failure", () => {
    const state = recoverInterruptedEnvironmentState(
      {
        stage: "preview_18",
        lifecycle: "destroying",
        operationId: "destroy-1",
        operationStartedAt: "2026-07-30T12:00:00.000Z",
        progress: [],
      },
      "2026-07-30T12:01:00.000Z",
    );
    expect(state).toEqual({
      stage: "preview_18",
      lifecycle: "failed",
      operationId: "destroy-1",
      operationStartedAt: "2026-07-30T12:00:00.000Z",
      operationFinishedAt: "2026-07-30T12:01:00.000Z",
      lastError: "Environment manager restarted while destroying; retry the operation.",
      progress: [],
    });
    expect(wasEnvironmentDestroyInterrupted(state, "destroy-1")).toBe(true);
    expect(wasEnvironmentDestroyInterrupted(state, "destroy-2")).toBe(false);
    expect(
      wasEnvironmentDestroyInterrupted(
        {
          ...state,
          lastError: "Cloudflare rejected one resource deletion.",
        },
        "destroy-1",
      ),
    ).toBe(false);
  });

  test("does not classify another interrupted lifecycle as resumable destruction", () => {
    expect(
      wasEnvironmentDestroyInterrupted(
        recoverInterruptedEnvironmentState(
          {
            stage: "preview_18",
            lifecycle: "deploying",
            operationId: "deploy-1",
            operationStartedAt: "2026-07-30T12:00:00.000Z",
            progress: [],
          },
          "2026-07-30T12:01:00.000Z",
        ),
        "deploy-1",
      ),
    ).toBe(false);
  });

  test("preserves an explicitly completed partial destroy batch across restarts", () => {
    const state = {
      stage: "preview_18",
      lifecycle: "destroying",
      operationStartedAt: "2026-07-30T12:00:00.000Z",
      operationFinishedAt: "2026-07-30T12:01:00.000Z",
      progress: [
        {
          id: "wrangler-artifacts",
          type: "Cloudflare Artifacts",
          status: "destroying",
        },
      ],
    } satisfies PersistedEnvironmentState;

    expect(recoverInterruptedEnvironmentState(state, "2026-07-30T12:02:00.000Z")).toEqual(state);
  });
});
