import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordedSpans, resetRecordedSpans } from "../../test/cloudflare-workers-shim.ts";
import type { DynamicWorkerRef } from "./schemas.ts";
import { DynamicWorkerRunner, type DynamicWorkerTraceRole } from "./worker-runner.ts";

const h = vi.hoisted(() => ({
  handleAssetRequest: vi.fn(),
  itxEntrypointProps: vi.fn((input: unknown) => input),
  loadResolvedWorker: vi.fn(),
  projectEgressFetcher: vi.fn(() => ({})),
  resolveWorkerSource: vi.fn(),
  statefulFetch: vi.fn(),
  statefulInvokeCapability: vi.fn(),
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
  itxEntrypointProps: h.itxEntrypointProps,
}));

vi.mock("../projects/utils.ts", () => ({
  projectEgressFetcher: h.projectEgressFetcher,
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
  h.itxEntrypointProps.mockClear();
  h.loadResolvedWorker.mockReset();
  h.projectEgressFetcher.mockClear();
  h.resolveWorkerSource
    .mockReset()
    .mockRejectedValue(new Error("stop after entering the trace span"));
  h.statefulFetch.mockReset().mockRejectedValue(new Error("stop at stateful fetch"));
  h.statefulInvokeCapability
    .mockReset()
    .mockRejectedValue(new Error("stop at stateful invocation"));
  h.workerGetByName.mockReset().mockReturnValue({
    fetch: h.statefulFetch,
    invokeCapability: h.statefulInvokeCapability,
  });
});

it("gives bare fetch and scoped ITX the same host-minted invocation source", () => {
  const source = {
    kind: "script-execution" as const,
    executionId: "agent-output:119",
    scriptRunRequestedEventOffset: 123,
    streamPath: "/agents/refund-agent",
  };

  new DynamicWorkerRunner({
    streamContext: source,
    exports: {} as ExecutionContext["exports"],
    projectId: "prj_private",
    scopePath: "/agents/refund-agent",
  });

  expect(h.itxEntrypointProps).toHaveBeenCalledWith({
    streamContext: source,
    path: "/agents/refund-agent",
    projectId: "prj_private",
    purpose: "userspace",
  });
  expect(h.projectEgressFetcher).toHaveBeenCalledWith(expect.anything(), "prj_private", source);
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
      streamContext: { kind: "scope", scopePath: `/${privateMarker}` },
      exports: {} as ExecutionContext["exports"],
      projectId: "prj_private",
      scopePath: `/${privateMarker}`,
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
      ok: true,
      source: {
        assetConfig: undefined,
        assetManifest: { "/client.js": { etag: "asset-etag" } },
        assets: { "client.js": "console.log('client')" },
        cacheKey: "build-key",
        commitOid: "commit-1",
        mainModule: "server.js",
        modules: {},
        wranglerConfig: undefined,
      },
    });
    h.handleAssetRequest.mockResolvedValue(
      new Response("console.log('client')", {
        headers: { "content-type": "text/javascript" },
      }),
    );
    const runner = new DynamicWorkerRunner({
      streamContext: { kind: "scope", scopePath: statefulAppRef.path },
      exports: {} as ExecutionContext["exports"],
      projectId: "prj_private",
      scopePath: statefulAppRef.path,
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
      streamContext: { kind: "scope", scopePath: statefulAppRef.path },
      exports: {} as ExecutionContext["exports"],
      projectId: "prj_private",
      scopePath: statefulAppRef.path,
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

it("turns a stateful source-build result into a local terminal delivery error", async () => {
  h.statefulInvokeCapability.mockImplementation(
    async ({ buildFailureNonce }: { buildFailureNonce: string }) => [
      buildFailureNonce,
      { kind: "source", message: 'No such module "yaml".' },
    ],
  );
  const runner = new DynamicWorkerRunner({
    streamContext: { kind: "scope", scopePath: statefulRef.path },
    exports: {} as ExecutionContext["exports"],
    projectId: "prj_private",
    scopePath: statefulRef.path,
  });

  const invocation = runner.invokeCapability({
    path: ["processor", "wakeStreamSubscriber"],
    ref: statefulRef,
  });

  await expect(invocation).rejects.toMatchObject({
    message: 'No such module "yaml".',
    name: "WorkerBuildFailedError",
    retryable: false,
  });
});

it("returns a stateful worker's successful value without wrapping its live stubs", async () => {
  const liveStub = {
    [Symbol.dispose]: vi.fn(),
    dup: vi.fn(),
    poke: vi.fn(),
  };
  const returned = {
    checkpointOffset: 12,
    sink: liveStub,
    workerBuildFailure: {
      failure: { kind: "source", message: "customer data" },
      nonce: "customer-controlled",
    },
  };
  h.statefulInvokeCapability.mockResolvedValue(returned);
  const runner = new DynamicWorkerRunner({
    streamContext: { kind: "scope", scopePath: statefulRef.path },
    exports: {} as ExecutionContext["exports"],
    projectId: "prj_private",
    scopePath: statefulRef.path,
  });

  await expect(
    runner.invokeCapability({
      path: ["processor", "wakeStreamSubscriber"],
      ref: statefulRef,
    }),
  ).resolves.toBe(returned);
});

it("returns a bare stateful RPC stub without probing it for a build failure", async () => {
  const returned = new Proxy(
    {},
    {
      get(target, property, receiver) {
        if (property === "workerBuildFailure") throw new Error("bare RPC stub was probed");
        return Reflect.get(target, property, receiver);
      },
    },
  );
  h.statefulInvokeCapability.mockResolvedValue(returned);
  const runner = new DynamicWorkerRunner({
    streamContext: { kind: "scope", scopePath: statefulRef.path },
    exports: {} as ExecutionContext["exports"],
    projectId: "prj_private",
    scopePath: statefulRef.path,
  });

  await expect(
    runner.invokeCapability({
      path: ["processor", "wakeStreamSubscriber"],
      ref: statefulRef,
    }),
  ).resolves.toBe(returned);
});
