import { beforeEach, describe, expect, test, vi } from "vitest";
import type { StreamContext } from "../projects/stream-context.ts";
import type { DynamicWorkerSource } from "./schemas.ts";

const h = vi.hoisted(() => {
  class FakeKv {
    readonly data = new Map<string, string>();

    async get(key: string, type?: string): Promise<unknown> {
      const value = this.data.get(key);
      if (!value) return null;
      return type === "json" ? JSON.parse(value) : value;
    }

    async put(key: string, value: string): Promise<void> {
      this.data.set(key, value);
    }
  }

  const kv = new FakeKv();
  const state = {
    artifactDisposals: 0,
    buildCalls: [] as string[],
    buildGate: undefined as Promise<void> | undefined,
    buildOperations: [] as Promise<unknown>[],
    coordinatorBudgets: [] as Array<number | undefined>,
    failBuilds: false,
    failRuntime: false,
    files: { "worker.ts": "v1" } as Record<string, string>,
    head: { branch: "main", commitOid: "c1", contentHash: "h1" },
    headDisposals: 0,
    loaderCalls: [] as Array<{ config: Record<string, unknown>; key: string }>,
    oneOffLoaderCalls: [] as Array<Record<string, unknown>>,
    repoDisposals: 0,
    snapshotDisposals: 0,
    snapshotCalls: [] as Array<Record<string, unknown>>,
    wranglerConfig: undefined as
      | { compatibilityDate?: string; compatibilityFlags?: string[] }
      | undefined,
  };
  const executeWorkerBuild = async (input: { files: Record<string, string> }) => {
    state.buildCalls.push(input.files["worker.ts"] ?? input.files["main.js"] ?? "unknown source");
    if (state.buildGate) await state.buildGate;
    if (state.failBuilds) {
      return {
        failure: { kind: "source" as const, message: "esbuild exploded" },
        ok: false as const,
      };
    }
    if (state.failRuntime) throw new Error("build runtime interrupted");
    return {
      ok: true as const,
      output: {
        assetManifest: {},
        assets: {},
        mainModule: "worker.js",
        modules: { "worker.js": `// build of ${input.files["worker.ts"]}` },
        warnings: [],
        wranglerConfig: state.wranglerConfig,
      },
    };
  };
  const itxEnv = {
    LOADER: {
      get: (key: string, callback: () => Record<string, unknown>) => {
        state.loaderCalls.push({ config: callback(), key });
        return {};
      },
      load: (config: Record<string, unknown>) => {
        state.oneOffLoaderCalls.push(config);
        return {};
      },
    },
    REPO: {
      getByName: () => ({
        [Symbol.dispose]() {
          state.repoDisposals++;
        },
        getFilesSnapshot: async (input: Record<string, unknown>) => {
          state.snapshotCalls.push(input);
          return {
            files: state.files,
            [Symbol.dispose]() {
              state.snapshotDisposals++;
            },
          };
        },
        getHead: async () => ({
          ...state.head,
          [Symbol.dispose]() {
            state.headDisposals++;
          },
        }),
      }),
    },
    WORKER_BUILD_CACHE: kv,
    WORKER_BUILD_COORDINATOR: {
      getByName: () => ({
        build: (
          request: import("./worker-build-capability.ts").WorkerBuildRequest,
          buildBudgetMs?: number,
        ) => {
          state.coordinatorBudgets.push(buildBudgetMs);
          const operation = (async () => {
            const { executeCoordinatedWorkerBuild } = await import("./worker-build-capability.ts");
            return await executeCoordinatedWorkerBuild(request, itxEnv as never);
          })();
          state.buildOperations.push(operation);
          const result =
            buildBudgetMs === 0
              ? Promise.reject(
                  Object.assign(new Error("This worker is still building."), {
                    name: "WorkerBuildInProgressError",
                  }),
                )
              : operation.then((artifact) => ({
                  ...artifact,
                  [Symbol.dispose]() {
                    state.artifactDisposals++;
                  },
                }));
          return result;
        },
      }),
    },
    WORKER_BUNDLER: {},
    CF_VERSION_METADATA: { id: "version-1" },
    WORKER_SELF: "os-test",
  };
  return { executeWorkerBuild, itxEnv, kv, state };
});

vi.mock("../../env.ts", () => ({
  itxEnv: h.itxEnv,
  workerVersion: (env: { CF_VERSION_METADATA?: { id: string } }) =>
    env.CF_VERSION_METADATA?.id ?? "unversioned",
}));
vi.mock("./build-backend.ts", () => ({
  WORKER_BUNDLER_VERSION: "0.2.1",
  WORKER_COMPATIBILITY_DATE: "2026-05-01",
  WORKER_COMPATIBILITY_FLAGS: ["nodejs_compat"],
  executeWorkerBuild: h.executeWorkerBuild,
}));

const { isWorkerBuildFailedError, WORKER_BUILD_ARTIFACT_SCHEMA_VERSION } =
  await import("./artifact-store.ts");
const { isWorkerBuildInProgressError, loadResolvedWorker, resolveWorkerSource } =
  await import("./worker-loader.ts");
const artifactKeyPattern = new RegExp(
  `^worker-build/v${WORKER_BUILD_ARTIFACT_SCHEMA_VERSION}/complete/.+\\.json$`,
);

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
  await Promise.allSettled(h.state.buildOperations.splice(0));
  h.kv.data.clear();
  h.state.artifactDisposals = 0;
  h.state.buildCalls.splice(0);
  h.state.buildGate = undefined;
  h.state.coordinatorBudgets.splice(0);
  h.state.failBuilds = false;
  h.state.failRuntime = false;
  h.state.headDisposals = 0;
  h.state.loaderCalls.splice(0);
  h.state.oneOffLoaderCalls.splice(0);
  h.state.repoDisposals = 0;
  h.state.snapshotDisposals = 0;
  h.state.snapshotCalls.splice(0);
  h.itxEnv.CF_VERSION_METADATA.id = "version-1";
  h.state.wranglerConfig = undefined;
});

describe("resolveWorkerSource", () => {
  test("builds once, stores one immutable record, and returns its repo commit", async () => {
    setCommit("c1", "fresh-build", "A1");
    const first = sourceFrom(
      await resolveWorkerSource({
        projectId: "prj_a",
        source: repoSource("/repos/fresh-build"),
      }),
    );

    expect(first.commitOid).toBe("c1");
    expect(first.modules["worker.js"]).toContain("A1");
    expect(h.state.buildCalls).toEqual(["A1"]);
    expect(h.state.artifactDisposals).toBe(1);
    expect(h.state.headDisposals).toBe(1);
    expect(h.state.repoDisposals).toBe(2);
    expect(h.state.snapshotDisposals).toBe(1);
    expect([...h.kv.data.keys()]).toEqual([expect.stringMatching(artifactKeyPattern)]);

    const second = sourceFrom(
      await resolveWorkerSource({
        projectId: "prj_a",
        source: repoSource("/repos/fresh-build"),
      }),
    );
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(h.state.buildCalls).toEqual(["A1"]);
    expect(h.state.repoDisposals).toBe(3);
  });

  test("shares deterministic artifacts across projects", async () => {
    setCommit("c1", "shared-build", "SHARED");
    const source = repoSource("/repos/shared-build");
    const first = sourceFrom(await resolveWorkerSource({ projectId: "prj_1", source }));
    const second = sourceFrom(await resolveWorkerSource({ projectId: "prj_2", source }));

    expect(second.cacheKey).toBe(first.cacheKey);
    expect(h.state.buildCalls).toEqual(["SHARED"]);
  });

  test("loads a one-off script without retaining a cache identity", async () => {
    const resolved = sourceFrom(
      await resolveWorkerSource({
        projectId: "prj_script",
        source: {
          createWorker: {
            files: { files: { "main.js": "export default { oneOff: true };" }, type: "inline" },
          },
        },
      }),
    );

    loadResolvedWorker({
      bindings: {},
      globalOutbound: {} as Fetcher,
      loaderInstanceNonce: "run-script-1",
      mode: "one-off",
      projectId: "prj_script",
      resolved,
      scopePath: "/agents/refund-agent",
      streamContext: {
        kind: "script-execution",
        executionId: "agent-output:1",
        scriptRunRequestedEventOffset: 2,
        streamPath: "/agents/refund-agent",
      },
    });

    expect(h.state.oneOffLoaderCalls).toHaveLength(1);
    expect(h.state.loaderCalls).toEqual([]);
  });

  test("returns and does not cache a source-build failure", async () => {
    setCommit("c1", "broken-build", "BROKEN");
    const source = repoSource("/repos/broken-build");
    h.state.failBuilds = true;

    const first = await resolveWorkerSource({ projectId: "prj_broken", source });
    expect(first).toEqual({
      failure: { kind: "source", message: "esbuild exploded" },
      ok: false,
    });
    expect(h.state.buildCalls).toEqual(["BROKEN"]);
    expect(h.kv.data.size).toBe(0);

    h.state.failBuilds = false;
    const recovered = sourceFrom(await resolveWorkerSource({ projectId: "prj_broken", source }));
    expect(recovered.modules["worker.js"]).toContain("BROKEN");
    expect(h.state.buildCalls).toEqual(["BROKEN", "BROKEN"]);
  });

  test("does not cache an infrastructure failure", async () => {
    setCommit("c1", "runtime-failure", "RETRY");
    const source = repoSource("/repos/runtime-failure");
    h.state.failRuntime = true;
    const failed = resolveWorkerSource({ projectId: "prj_retry", source });
    await expect(failed).rejects.toThrow("build runtime interrupted");
    await expect(failed).rejects.not.toSatisfy(isWorkerBuildFailedError);
    expect(h.kv.data.size).toBe(0);

    h.state.failRuntime = false;
    const recovered = sourceFrom(await resolveWorkerSource({ projectId: "prj_retry", source }));
    expect(recovered.modules["worker.js"]).toContain("RETRY");
    expect(h.state.buildCalls).toEqual(["RETRY", "RETRY"]);
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
    });
    try {
      await expect(budgeted).rejects.toSatisfy(isWorkerBuildInProgressError);
      expect(h.state.coordinatorBudgets).toEqual([0]);
    } finally {
      releaseBuild();
      await Promise.all(h.state.buildOperations.splice(0));
      h.state.buildGate = undefined;
    }
    expect(h.state.buildCalls).toEqual(["SLOW"]);
    expect(h.state.snapshotDisposals).toBe(1);
    expect([...h.kv.data.keys()]).toEqual([expect.stringMatching(artifactKeyPattern)]);

    const ready = sourceFrom(
      await resolveWorkerSource({
        projectId: "prj_slow",
        source: repoSource("/repos/budgeted-build"),
      }),
    );
    expect(ready.modules["worker.js"]).toContain("SLOW");
    expect(h.state.buildCalls).toEqual(["SLOW"]);
  });

  test("passes bundle: false through the normal worker-bundler build path", async () => {
    const resolved = sourceFrom(
      await resolveWorkerSource({
        projectId: "prj_inline",
        source: {
          createWorker: {
            bundle: false,
            entryPoint: "main.js",
            files: { files: { "main.js": "export default {};" }, type: "inline" },
          },
        },
      }),
    );

    expect(resolved.commitOid).toBeUndefined();
    expect(resolved.mainModule).toBe("worker.js");
    expect(h.state.buildCalls).toEqual(["export default {};"]);
  });

  test("loads with compatibility settings returned by worker-bundler", async () => {
    h.state.wranglerConfig = {
      compatibilityDate: "2026-07-01",
      compatibilityFlags: ["nodejs_compat_v2"],
    };
    const resolved = sourceFrom(
      await resolveWorkerSource({
        projectId: "prj_wrangler",
        source: {
          createWorker: {
            files: { files: { "main.js": "export default {};" }, type: "inline" },
          },
        },
      }),
    );

    loadResolvedWorker({
      bindings: {},
      globalOutbound: {} as Fetcher,
      loaderInstanceNonce: "runner-1",
      mode: "cached",
      projectId: "prj_wrangler",
      resolved,
      scopePath: "/",
      streamContext: { kind: "scope", scopePath: "/" },
    });

    expect(h.state.loaderCalls[0]?.config).toMatchObject({
      compatibilityDate: "2026-07-01",
      compatibilityFlags: ["nodejs_compat_v2"],
    });
    expect(h.state.loaderCalls[0]?.key).toContain("worker-loader:os-test:version-1:");
  });

  test("does not reuse a loaded isolate across parent deployments", async () => {
    const resolved = sourceFrom(
      await resolveWorkerSource({
        projectId: "prj_rollout",
        source: {
          createWorker: {
            files: { files: { "main.js": "export default {};" }, type: "inline" },
          },
        },
      }),
    );
    const load = () =>
      loadResolvedWorker({
        bindings: {},
        globalOutbound: {} as Fetcher,
        loaderInstanceNonce: "runner-1",
        mode: "cached",
        projectId: "prj_rollout",
        resolved,
        scopePath: "/",
        streamContext: { kind: "scope", scopePath: "/" },
      });

    load();
    h.itxEnv.CF_VERSION_METADATA.id = "version-2";
    load();

    expect(h.state.loaderCalls.map(({ key }) => key)).toEqual([
      expect.stringContaining("worker-loader:os-test:version-1:"),
      expect.stringContaining("worker-loader:os-test:version-2:"),
    ]);
  });

  test("scopes loaded workers to the runner that minted their RPC bindings", async () => {
    const resolved = sourceFrom(
      await resolveWorkerSource({
        projectId: "prj_replacement",
        source: {
          createWorker: {
            files: { files: { "main.js": "export default {};" }, type: "inline" },
          },
        },
      }),
    );
    const load = (loaderInstanceNonce: string) =>
      loadResolvedWorker({
        bindings: {},
        globalOutbound: {} as Fetcher,
        loaderInstanceNonce,
        mode: "cached",
        projectId: "prj_replacement",
        resolved,
        scopePath: "/",
        streamContext: { kind: "scope", scopePath: "/" },
      });

    load("runner-1");
    load("runner-2");
    load("runner-2");

    const [firstRunner, secondRunner, reusedBySecondRunner] = h.state.loaderCalls.map(
      ({ key }) => key,
    );
    expect(firstRunner).toMatch(/:runner-1$/);
    expect(secondRunner).toMatch(/:runner-2$/);
    expect(secondRunner).not.toBe(firstRunner);
    expect(reusedBySecondRunner).toBe(secondRunner);
  });

  test("does not reuse stream-context-bound workers across script executions", async () => {
    const resolved = sourceFrom(
      await resolveWorkerSource({
        projectId: "prj_context",
        source: {
          createWorker: {
            files: { files: { "main.js": "export default {};" }, type: "inline" },
          },
        },
      }),
    );
    const load = (streamContext: StreamContext) =>
      loadResolvedWorker({
        bindings: {},
        globalOutbound: {} as Fetcher,
        loaderInstanceNonce: "runner-1",
        mode: "cached",
        projectId: "prj_context",
        resolved,
        scopePath: "/agents/refund-agent",
        streamContext,
      });

    load({
      kind: "script-execution",
      executionId: "agent-output:1",
      scriptRunRequestedEventOffset: 2,
      streamPath: "/agents/refund-agent",
    });
    const secondContext = {
      kind: "script-execution",
      executionId: "agent-output:3",
      scriptRunRequestedEventOffset: 4,
      streamPath: "/agents/refund-agent",
    } satisfies StreamContext;
    load(secondContext);
    load(secondContext);

    expect(h.state.loaderCalls[0]?.key).not.toBe(h.state.loaderCalls[1]?.key);
    expect(h.state.loaderCalls[2]?.key).toBe(h.state.loaderCalls[1]?.key);
  });
});

function sourceFrom(result: Awaited<ReturnType<typeof resolveWorkerSource>>) {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.failure.message);
  return result.source;
}
