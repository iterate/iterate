import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DynamicWorkerSource } from "./schemas.ts";

const h = vi.hoisted(() => {
  class FakeKv {
    readonly data = new Map<string, string>();

    async get(key: string, type?: string): Promise<unknown> {
      const value = this.data.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    }

    async put(key: string, value: string): Promise<void> {
      if (state.failCacheWrites) throw new Error("KV unavailable");
      this.data.set(key, value);
    }
  }

  const kv = new FakeKv();
  const state = {
    buildCalls: [] as string[],
    buildGate: undefined as Promise<void> | undefined,
    failBuilds: false,
    failCacheWrites: false,
    failRuntime: false,
    files: { "worker.ts": "v1" } as Record<string, string>,
    head: { branch: "main", commitOid: "c1", contentHash: "h1" },
    loaderCalls: [] as Array<{ config: Record<string, unknown>; key: string }>,
    snapshotCalls: [] as Array<Record<string, unknown>>,
    wranglerConfig: undefined as
      | { compatibilityDate?: string; compatibilityFlags?: string[] }
      | undefined,
  };
  const executeWorkerBuild = async (input: { files: Record<string, string> }) => {
    state.buildCalls.push(input.files["worker.ts"] ?? input.files["main.js"] ?? "unknown source");
    if (state.buildGate !== undefined) await state.buildGate;
    if (state.failBuilds) {
      const failure = new Error("esbuild exploded");
      failure.name = "WorkerBuildFailedError";
      throw failure;
    }
    if (state.failRuntime) throw new Error("build runtime interrupted");
    return {
      assetManifest: {},
      assets: {},
      mainModule: "worker.js",
      modules: { "worker.js": `// build of ${input.files["worker.ts"]}` },
      warnings: [],
      wranglerConfig: state.wranglerConfig,
    };
  };
  const itxEnv = {
    LOADER: {
      get: (key: string, callback: () => Record<string, unknown>) => {
        state.loaderCalls.push({ config: callback(), key });
        return {};
      },
    },
    REPO: {
      getByName: () => ({
        getFilesSnapshot: async (input: Record<string, unknown>) => {
          state.snapshotCalls.push(input);
          return { files: state.files };
        },
        getHead: async () => state.head,
      }),
    },
    WORKER_BUILD_CACHE: kv,
    WORKER_BUNDLER: {},
    WORKER_SELF: "os-test",
  };
  return { executeWorkerBuild, itxEnv, kv, state };
});

vi.mock("../../env.ts", () => ({ itxEnv: h.itxEnv }));
vi.mock("./build-backend.ts", () => ({
  WORKER_BUNDLER_VERSION: "0.2.1",
  WORKER_COMPATIBILITY_DATE: "2026-05-01",
  WORKER_COMPATIBILITY_FLAGS: ["nodejs_compat"],
  executeWorkerBuild: h.executeWorkerBuild,
  workerVirtualModules: (overrides?: Record<string, string>) => ({
    "iterate/sdk": "test sdk",
    ...overrides,
  }),
}));

const { isWorkerBuildFailedError } = await import("./artifact-store.ts");
const { isWorkerBuildInProgressError, loadResolvedWorker, resolveWorkerSource } =
  await import("./worker-loader.ts");

const pending: Promise<unknown>[] = [];
const waitUntil = (promise: Promise<unknown>) => {
  pending.push(promise);
};

const repoSource = (repoPath: string): DynamicWorkerSource => ({
  createWorker: {
    entryPoint: "worker.ts",
    files: { repoPath, type: "repo" },
  },
});

function setCommit(commitOid: string, contentHash: string, workerTs: string) {
  h.state.head = { branch: "main", commitOid, contentHash };
  h.state.files = { "worker.ts": workerTs };
}

beforeEach(async () => {
  await Promise.allSettled(pending.splice(0));
  h.kv.data.clear();
  h.state.buildCalls.splice(0);
  h.state.buildGate = undefined;
  h.state.failBuilds = false;
  h.state.failCacheWrites = false;
  h.state.failRuntime = false;
  h.state.loaderCalls.splice(0);
  h.state.snapshotCalls.splice(0);
  h.state.wranglerConfig = undefined;
});

describe("resolveWorkerSource", () => {
  test("builds once, stores one immutable record, and returns its repo commit", async () => {
    setCommit("c1", "fresh-build", "A1");
    const first = await resolveWorkerSource({
      projectId: "prj_a",
      source: repoSource("/repos/fresh-build"),
      waitUntil,
    });

    expect(first.commitOid).toBe("c1");
    expect(first.modules["worker.js"]).toContain("A1");
    expect(h.state.buildCalls).toEqual(["A1"]);
    expect([...h.kv.data.keys()]).toEqual([
      expect.stringMatching(/^worker-build\/v9\/complete\/.+\.json$/),
    ]);

    const second = await resolveWorkerSource({
      projectId: "prj_a",
      source: repoSource("/repos/fresh-build"),
      waitUntil,
    });
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(h.state.buildCalls).toEqual(["A1"]);
  });

  test("shares deterministic artifacts across projects", async () => {
    setCommit("c1", "shared-build", "SHARED");
    const source = repoSource("/repos/shared-build");
    const first = await resolveWorkerSource({ projectId: "prj_1", source, waitUntil });
    const second = await resolveWorkerSource({ projectId: "prj_2", source, waitUntil });

    expect(second.cacheKey).toBe(first.cacheKey);
    expect(h.state.buildCalls).toEqual(["SHARED"]);
  });

  test("replays a cached source failure without rebuilding", async () => {
    setCommit("c1", "broken-build", "BROKEN");
    const source = repoSource("/repos/broken-build");
    h.state.failBuilds = true;

    const first = resolveWorkerSource({ projectId: "prj_broken", source, waitUntil });
    await expect(first).rejects.toSatisfy(isWorkerBuildFailedError);
    expect(h.state.buildCalls).toEqual(["BROKEN"]);
    expect([...h.kv.data.values()].map((value) => JSON.parse(value))).toEqual([
      expect.objectContaining({ message: "esbuild exploded", status: "failed" }),
    ]);

    const second = resolveWorkerSource({ projectId: "prj_broken", source, waitUntil });
    await expect(second).rejects.toThrow("esbuild exploded");
    expect(h.state.buildCalls).toEqual(["BROKEN"]);
  });

  test("does not cache an infrastructure failure", async () => {
    setCommit("c1", "runtime-failure", "RETRY");
    const source = repoSource("/repos/runtime-failure");
    h.state.failRuntime = true;
    const failed = resolveWorkerSource({ projectId: "prj_retry", source, waitUntil });
    await expect(failed).rejects.toThrow("build runtime interrupted");
    await expect(failed).rejects.not.toSatisfy(isWorkerBuildFailedError);
    expect(h.kv.data.size).toBe(0);

    h.state.failRuntime = false;
    const recovered = await resolveWorkerSource({ projectId: "prj_retry", source, waitUntil });
    expect(recovered.modules["worker.js"]).toContain("RETRY");
    expect(h.state.buildCalls).toEqual(["RETRY", "RETRY"]);
  });

  test("preserves a source failure when its failure record cannot be cached", async () => {
    setCommit("c1", "uncached-broken-build", "BROKEN");
    h.state.failBuilds = true;
    h.state.failCacheWrites = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        resolveWorkerSource({
          projectId: "prj_uncached_broken",
          source: repoSource("/repos/uncached-broken-build"),
          waitUntil,
        }),
      ).rejects.toThrow("esbuild exploded");
      expect(consoleError).toHaveBeenCalledWith(
        "failed to cache dynamic worker build failure",
        expect.objectContaining({ error: expect.objectContaining({ message: "KV unavailable" }) }),
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(h.kv.data.size).toBe(0);
  });

  test("passes omitted repo masks through without platform defaults", async () => {
    setCommit("c1", "no-default-masks", "ALL FILES");
    await resolveWorkerSource({
      projectId: "prj_defaults",
      source: {
        createWorker: {
          files: { repoPath: "/repos/no-default-masks", type: "repo" },
        },
      },
      waitUntil,
    });

    expect(h.state.snapshotCalls).toEqual([
      {
        branch: "main",
        commitOid: "c1",
        exclude: undefined,
        include: undefined,
      },
    ]);
    expect(h.state.buildCalls).toEqual(["ALL FILES"]);
  });

  test("lets a browser request stop waiting while its build finishes", async () => {
    setCommit("c1", "budgeted-build", "SLOW");
    let releaseBuild!: () => void;
    h.state.buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });

    const budgeted = resolveWorkerSource({
      buildBudgetMs: 0,
      projectId: "prj_slow",
      source: repoSource("/repos/budgeted-build"),
      waitUntil,
    });
    await expect(budgeted).rejects.toSatisfy(isWorkerBuildInProgressError);
    expect(pending).toHaveLength(1);
    expect(h.state.buildCalls).toEqual(["SLOW"]);

    releaseBuild();
    await Promise.all(pending.splice(0));
    h.state.buildGate = undefined;
    const ready = await resolveWorkerSource({
      projectId: "prj_slow",
      source: repoSource("/repos/budgeted-build"),
      waitUntil,
    });
    expect(ready.modules["worker.js"]).toContain("SLOW");
    expect(h.state.buildCalls).toEqual(["SLOW"]);
  });

  test("passes bundle: false through the normal worker-bundler build path", async () => {
    const resolved = await resolveWorkerSource({
      projectId: "prj_inline",
      source: {
        createWorker: {
          bundle: false,
          entryPoint: "main.js",
          files: { files: { "main.js": "export default {};" }, type: "inline" },
        },
      },
      waitUntil,
    });

    expect(resolved.commitOid).toBeUndefined();
    expect(resolved.mainModule).toBe("worker.js");
    expect(h.state.buildCalls).toEqual(["export default {};"]);
  });

  test("loads with compatibility settings returned by worker-bundler", async () => {
    h.state.wranglerConfig = {
      compatibilityDate: "2026-07-01",
      compatibilityFlags: ["nodejs_compat_v2"],
    };
    const resolved = await resolveWorkerSource({
      projectId: "prj_wrangler",
      source: {
        createWorker: {
          files: { files: { "main.js": "export default {};" }, type: "inline" },
        },
      },
      waitUntil,
    });

    loadResolvedWorker({
      bindings: {},
      globalOutbound: {} as Fetcher,
      projectId: "prj_wrangler",
      resolved,
      scopePath: "/",
    });

    expect(h.state.loaderCalls[0]?.config).toMatchObject({
      compatibilityDate: "2026-07-01",
      compatibilityFlags: ["nodejs_compat_v2"],
    });
  });
});
