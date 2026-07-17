import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordedSpans, resetRecordedSpans } from "../../test/cloudflare-workers-shim.ts";
import type { DynamicWorkerRef } from "./schemas.ts";
import { DynamicWorkerRunner, type DynamicWorkerTraceRole } from "./worker-runner.ts";

const { mockItxEntrypointProps } = vi.hoisted(() => ({
  mockItxEntrypointProps: vi.fn((props: unknown) => props),
}));

vi.mock("../itx/utils.ts", () => ({
  itxEntrypointBinding: () => ({}),
  itxEntrypointProps: mockItxEntrypointProps,
}));

vi.mock("../projects/utils.ts", () => ({
  projectEgressFetcher: () => ({}),
}));

vi.mock("./worker-loader.ts", () => ({
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
  resetRecordedSpans();
  mockItxEntrypointProps.mockClear();
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

    expect(mockItxEntrypointProps).toHaveBeenCalledWith({
      path: `/${privateMarker}`,
      projectId: "prj_private",
      purpose: "userspace",
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
