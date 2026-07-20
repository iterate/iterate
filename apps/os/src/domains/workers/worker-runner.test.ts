import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordedSpans, resetRecordedSpans } from "../../test/cloudflare-workers-shim.ts";
import type { DynamicWorkerRef } from "./schemas.ts";
import { DynamicWorkerRunner, type DynamicWorkerTraceRole } from "./worker-runner.ts";

const h = vi.hoisted(() => ({
  handleAssetRequest: vi.fn(),
  loadResolvedWorker: vi.fn(),
  resolveWorkerSource: vi.fn(),
  statefulFetch: vi.fn(),
  workerGetByName: vi.fn(),
}));

vi.mock("../../env.ts", () => ({
  itxEnv: {
    WORKER: { getByName: h.workerGetByName },
    WORKER_BUNDLER: { handleAssetRequest: h.handleAssetRequest },
  },
}));

vi.mock("../itx/utils.ts", () => ({
  itxEntrypointBinding: () => ({}),
  itxEntrypointProps: () => ({}),
}));

vi.mock("../projects/utils.ts", () => ({
  projectEgressFetcher: () => ({}),
}));

vi.mock("./worker-loader.ts", () => ({
  loadResolvedWorker: h.loadResolvedWorker,
  resolveWorkerSource: h.resolveWorkerSource,
}));

const privateMarker = "customer@example.com/private-worker";
const inlineRef = {
  entrypoint: privateMarker,
  path: `/${privateMarker}`,
  source: {
    createWorker: {
      files: { files: { "private.ts": privateMarker }, type: "inline" },
    },
  },
  type: "stateless",
} satisfies DynamicWorkerRef;
const repoRef = {
  entrypoint: privateMarker,
  path: `/${privateMarker}`,
  source: {
    createWorker: {
      files: { repoPath: `/${privateMarker}`, type: "repo" },
    },
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
const statefulAppRef = {
  ...statefulRef,
  source: {
    createApp: {
      files: { files: { "server.ts": "export default {}" }, type: "inline" },
      server: "server.ts",
    },
  },
} satisfies DynamicWorkerRef;

beforeEach(() => {
  resetRecordedSpans();
  h.handleAssetRequest.mockReset();
  h.loadResolvedWorker.mockReset();
  h.resolveWorkerSource
    .mockReset()
    .mockRejectedValue(new Error("stop after entering the trace span"));
  h.statefulFetch.mockReset().mockRejectedValue(new Error("stop at stateful fetch"));
  h.workerGetByName.mockReset().mockReturnValue({ fetch: h.statefulFetch });
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
    const source =
      "createApp" in fixture.ref.source
        ? fixture.ref.source.createApp.files
        : fixture.ref.source.createWorker.files;
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
          "iterate.worker.source": source.type,
          "iterate.worker.type": fixture.ref.type,
        },
      },
      {
        name: `dynamic_worker.${fixture.expectedKind}.fetch`,
        attributes: {
          "iterate.worker.kind": fixture.expectedKind,
          "iterate.worker.operation": "fetch",
          "iterate.worker.source": source.type,
          "iterate.worker.type": fixture.ref.type,
        },
      },
    ]);
    expect(JSON.stringify(recordedSpans)).not.toContain(privateMarker);
  });
});

describe("createApp asset dispatch", () => {
  it("serves a stateful app asset before waking its Durable Object", async () => {
    h.resolveWorkerSource.mockResolvedValue({
      assetConfig: undefined,
      assetManifest: { "/client.js": { etag: "asset-etag" } },
      assets: { "client.js": "console.log('client')" },
      cacheKey: "build-key",
      commitOid: "commit-1",
      mainModule: "server.js",
      modules: {},
      wranglerConfig: undefined,
    });
    h.handleAssetRequest.mockResolvedValue(
      new Response("console.log('client')", {
        headers: { "content-type": "text/javascript" },
      }),
    );
    const runner = new DynamicWorkerRunner({
      exports: {} as ExecutionContext["exports"],
      projectId: "prj_private",
      scopePath: statefulAppRef.path,
      waitUntil: () => undefined,
    });

    const response = await runner.fetch({
      ref: statefulAppRef,
      request: new Request("https://example.com/client.js"),
    });

    expect(await response.text()).toBe("console.log('client')");
    expect(h.handleAssetRequest).toHaveBeenCalledOnce();
    expect(h.workerGetByName).not.toHaveBeenCalled();
  });

  it("sends a stateful app WebSocket upgrade directly to its Durable Object", async () => {
    h.statefulFetch.mockResolvedValue(new Response("upgrade lane"));
    const runner = new DynamicWorkerRunner({
      exports: {} as ExecutionContext["exports"],
      projectId: "prj_private",
      scopePath: statefulAppRef.path,
      waitUntil: () => undefined,
    });

    const response = await runner.fetch({
      ref: statefulAppRef,
      request: new Request("https://example.com/socket", {
        headers: { Upgrade: "websocket" },
      }),
    });

    expect(await response.text()).toBe("upgrade lane");
    expect(h.resolveWorkerSource).not.toHaveBeenCalled();
    expect(h.handleAssetRequest).not.toHaveBeenCalled();
    expect(h.workerGetByName).toHaveBeenCalledOnce();
  });
});
