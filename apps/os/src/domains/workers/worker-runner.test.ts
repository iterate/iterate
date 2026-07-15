import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordedSpans, resetRecordedSpans } from "../../test/cloudflare-workers-shim.ts";
import type { DynamicWorkerRef } from "./schemas.ts";
import {
  invalidateLoadedWorker,
  loadResolvedWorker,
  resolveWorkerSource,
} from "./worker-loader.ts";
import { DynamicWorkerRunner, type DynamicWorkerTraceRole } from "./worker-runner.ts";

vi.mock("../itx/utils.ts", () => ({
  itxEntrypointBinding: () => ({}),
  itxEntrypointProps: () => ({}),
}));

vi.mock("../projects/utils.ts", () => ({
  projectEgressFetcher: () => ({}),
}));

vi.mock("./worker-loader.ts", () => ({
  invalidateLoadedWorker: vi.fn(),
  isInvalidWorkerLoaderCloneError: (error: unknown) =>
    (error as { message?: unknown } | null)?.message ===
    "Unable to deserialize cloned data due to invalid or unsupported version.",
  loadResolvedWorker: vi.fn(),
  resolveCachedArtifact: vi.fn(),
  resolveWorkerSource: vi.fn(async () => {
    throw new Error("stop after entering the trace span");
  }),
}));

const privateMarker = "customer@example.com/private-worker";
const inlineRef = {
  entrypoint: privateMarker,
  path: `/${privateMarker}`,
  source: {
    files: { files: { "private.ts": privateMarker }, type: "inline" },
  },
  type: "stateless",
} satisfies DynamicWorkerRef;
const repoRef = {
  entrypoint: privateMarker,
  path: `/${privateMarker}`,
  source: {
    files: { repoPath: `/${privateMarker}`, type: "repo" },
  },
  type: "stateless",
} satisfies DynamicWorkerRef;
const statefulRef = {
  className: privateMarker,
  durableWorkerKey: "private-worker",
  path: `/${privateMarker}`,
  source: inlineRef.source,
  type: "stateful",
} satisfies DynamicWorkerRef;

beforeEach(() => {
  vi.clearAllMocks();
  resetRecordedSpans();
});

it("rotates a poisoned named loader isolate before propagating Cloudflare's clone error", async () => {
  const cloneError = new Error(
    "Unable to deserialize cloned data due to invalid or unsupported version.",
  );
  const resolved = {
    cacheKey: "artifact-v1",
    mainModule: "worker.js",
    modules: { "worker.js": "export default {}" },
  };
  vi.mocked(resolveWorkerSource).mockResolvedValueOnce({
    resolved,
    source: inlineRef.source,
    version: "artifact-v1",
  });
  vi.mocked(loadResolvedWorker).mockReturnValueOnce({
    getEntrypoint: () => ({
      processEventBatch: vi.fn().mockRejectedValue(cloneError),
    }),
  } as unknown as WorkerStub);
  const runner = new DynamicWorkerRunner({
    exports: {} as ExecutionContext["exports"],
    projectId: "prj_private",
    scopePath: "/",
    waitUntil: () => undefined,
  });

  await expect(
    runner.invokeCapability({
      flattenNestedPath: true,
      path: ["processEventBatch"],
      ref: inlineRef,
    }),
  ).rejects.toBe(cloneError);

  expect(invalidateLoadedWorker).toHaveBeenCalledOnce();
  expect(invalidateLoadedWorker).toHaveBeenCalledWith({
    projectId: "prj_private",
    ref: inlineRef,
    resolved,
    scopePath: "/",
  });
});

describe("dynamic worker spans", () => {
  it.each<{
    expectedKind: string;
    ref: DynamicWorkerRef;
    traceRole?: DynamicWorkerTraceRole;
  }>([
    { expectedKind: "project_config", ref: repoRef, traceRole: "project_config" },
    { expectedKind: "run_script", ref: inlineRef, traceRole: "run_script" },
    { expectedKind: "scheduler_action", ref: inlineRef, traceRole: "scheduler_action" },
    { expectedKind: "repo", ref: repoRef },
    { expectedKind: "inline", ref: inlineRef },
    { expectedKind: "stateful", ref: statefulRef },
  ])("uses the bounded $expectedKind kind for call and fetch", async (fixture) => {
    const runner = new DynamicWorkerRunner({
      exports: {} as ExecutionContext["exports"],
      projectId: "prj_private",
      scopePath: `/${privateMarker}`,
      waitUntil: () => undefined,
    });

    await expect(
      runner.invokeCapability({
        path: [privateMarker],
        ref: fixture.ref,
        traceRole: fixture.traceRole,
      }),
    ).rejects.toThrow();
    await expect(
      runner.fetch({
        ref: fixture.ref,
        request: new Request(`https://example.com/${privateMarker}`),
        traceRole: fixture.traceRole,
      }),
    ).rejects.toThrow();

    expect(recordedSpans).toEqual([
      {
        name: `dynamic_worker.${fixture.expectedKind}.call`,
        attributes: {
          "iterate.worker.kind": fixture.expectedKind,
          "iterate.worker.operation": "call",
          "iterate.worker.source": fixture.ref.source.files.type,
          "iterate.worker.type": fixture.ref.type,
        },
      },
      {
        name: `dynamic_worker.${fixture.expectedKind}.fetch`,
        attributes: {
          "iterate.worker.kind": fixture.expectedKind,
          "iterate.worker.operation": "fetch",
          "iterate.worker.source": fixture.ref.source.files.type,
          "iterate.worker.type": fixture.ref.type,
        },
      },
    ]);
    expect(JSON.stringify(recordedSpans)).not.toContain(privateMarker);
  });
});
