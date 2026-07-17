import { describe, expect, test, vi } from "vitest";
import type { DynamicWorkerSource } from "./schemas.ts";

// The serve-side resolve matrix: fresh vs stale fallbacks around the build
// backend. The seams worker-loader.ts actually uses are faked — the build
// backend module, repo head/snapshot, and the KV cache — so these tests
// drive resolveWorkerSource exactly like the runner does.
const h = vi.hoisted(() => {
  class FakeKv {
    readonly data = new Map<string, string>();
    async get(key: string, type?: string): Promise<unknown> {
      const value = this.data.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    }
    async put(key: string, value: string): Promise<void> {
      this.data.set(key, value);
    }
    async delete(key: string): Promise<void> {
      this.data.delete(key);
    }
  }
  const kv = new FakeKv();
  const state = {
    buildCalls: [] as string[],
    failBuilds: false,
    failTransport: false,
    files: { "worker.ts": "v1" } as Record<string, string>,
    head: { branch: "main", commitOid: "c1", contentHash: "h1" },
  };
  const executeWorkerBuild = async (input: { buildKey: string; files: Record<string, string> }) => {
    state.buildCalls.push(input.buildKey);
    if (state.failBuilds) {
      // Mirror the real backend's classification contract: genuine build
      // failures carry the NAME (matching is name-based because the real
      // pipeline's errors may cross RPC hops).
      const failure = new Error("esbuild exploded");
      failure.name = "WorkerBuildFailedError";
      throw failure;
    }
    if (state.failTransport) throw new Error("container transport disconnected");
    return {
      mainModule: "worker.js",
      modules: { "worker.js": `// build of ${input.files["worker.ts"]}` },
    };
  };
  const itxEnv = {
    LOADER: { get: () => ({}) },
    REPO: {
      getByName: () => ({
        getFilesSnapshot: async () => ({ files: state.files }),
        getHead: async () => state.head,
      }),
    },
    WORKER_BUILD_CACHE: kv,
    WORKER_SELF: "os-test",
  };
  return { executeWorkerBuild, itxEnv, kv, state };
});

vi.mock("../../env.ts", () => ({ itxEnv: h.itxEnv }));
vi.mock("./build-backend.ts", () => ({ executeWorkerBuild: h.executeWorkerBuild }));

const { isWorkerBuildFailedError } = await import("./artifact-store.ts");
const { resolveWorkerSource } = await import("./worker-loader.ts");

const pending: Promise<unknown>[] = [];
const waitUntil = (promise: Promise<unknown>) => {
  pending.push(promise);
};

// One repo per test: repoPath participates in build and last-good keys, so
// scenarios cannot see each other's artifacts or pointers.
const repoSource = (repoPath: string): DynamicWorkerSource => ({
  files: { repoPath, type: "repo" },
  options: { entryPoint: "worker.ts" },
});

function setCommit(commitOid: string, contentHash: string, workerTs: string) {
  h.state.head = { branch: "main", commitOid, contentHash };
  h.state.files = { "worker.ts": workerTs };
}

describe("resolveWorkerSource serve matrix", () => {
  test("a blocking build returns fresh serve info and records the last-good pointer", async () => {
    setCommit("c1", "repo-a-v1", "A1");
    const resolved = await resolveWorkerSource({
      projectId: "prj_a",
      source: repoSource("/repos/a"),
      waitUntil,
    });
    expect(resolved.serveInfo).toEqual({ commitOid: "c1", status: "fresh" });
    expect(resolved.modules["worker.js"]).toContain("A1");

    const pointers = [...h.kv.data.entries()].filter(([key]) =>
      key.startsWith("worker-last-good/"),
    );
    expect(pointers).toHaveLength(1);
    expect(JSON.parse(pointers[0]![1])).toMatchObject({
      buildKey: resolved.cacheKey,
      commitOid: "c1",
    });
  });

  test("the fetch lane serves the previous build while a new commit builds in the background", async () => {
    setCommit("c1", "repo-b-v1", "B1");
    await resolveWorkerSource({ projectId: "prj_b", source: repoSource("/repos/b"), waitUntil });
    const callsAfterSetup = h.state.buildCalls.length;

    setCommit("c2", "repo-b-v2", "B2");
    const stale = await resolveWorkerSource({
      buildBudgetMs: 5_000,
      projectId: "prj_b",
      source: repoSource("/repos/b"),
      waitUntil,
    });
    // The OLD build answers instantly, marked stale-building at its commit.
    expect(stale.serveInfo).toMatchObject({ commitOid: "c1", reason: "building", status: "stale" });
    expect(stale.modules["worker.js"]).toContain("B1");

    // ...while the fresh build was dispatched to the background and lands.
    await Promise.allSettled(pending.splice(0));
    expect(h.state.buildCalls.length).toBe(callsAfterSetup + 1);
    const fresh = await resolveWorkerSource({
      buildBudgetMs: 5_000,
      projectId: "prj_b",
      source: repoSource("/repos/b"),
      waitUntil,
    });
    expect(fresh.serveInfo).toMatchObject({ commitOid: "c2", status: "fresh" });
    expect(fresh.modules["worker.js"]).toContain("B2");
  });

  test("a failed rebuild: blocking callers get the named error, the fetch lane serves the previous build with the failure", async () => {
    setCommit("c1", "repo-c-v1", "C1");
    await resolveWorkerSource({ projectId: "prj_c", source: repoSource("/repos/c"), waitUntil });

    setCommit("c2", "repo-c-v2", "C2");
    h.state.failBuilds = true;
    try {
      // Blocking callers keep commit-then-call-sees-new-code: they get the
      // builder's own message under the named error, never stale code.
      const blocking = resolveWorkerSource({
        projectId: "prj_c",
        source: repoSource("/repos/c"),
        waitUntil,
      });
      await expect(blocking).rejects.toThrow("esbuild exploded");
      await expect(blocking).rejects.toSatisfy(isWorkerBuildFailedError);

      const callsBeforeStale = h.state.buildCalls.length;
      const stale = await resolveWorkerSource({
        buildBudgetMs: 5_000,
        projectId: "prj_c",
        source: repoSource("/repos/c"),
        waitUntil,
      });
      expect(stale.serveInfo).toMatchObject({
        commitOid: "c1",
        failure: { commitOid: "c2", message: "esbuild exploded" },
        reason: "build-failed",
        status: "stale",
      });
      expect(stale.modules["worker.js"]).toContain("C1");
      // A recorded failure is never rebuilt by the fetch lane within its TTL.
      expect(h.state.buildCalls.length).toBe(callsBeforeStale);
    } finally {
      h.state.failBuilds = false;
    }
  });

  test("a failed first-ever build answers budgeted callers from the recorded failure without a rebuild", async () => {
    setCommit("c1", "repo-d-v1", "D1");
    h.state.failBuilds = true;
    try {
      const first = resolveWorkerSource({
        buildBudgetMs: 5_000,
        projectId: "prj_d",
        source: repoSource("/repos/d"),
        waitUntil,
      });
      await expect(first).rejects.toSatisfy(isWorkerBuildFailedError);

      const callsAfterFirst = h.state.buildCalls.length;
      const second = resolveWorkerSource({
        buildBudgetMs: 5_000,
        projectId: "prj_d",
        source: repoSource("/repos/d"),
        waitUntil,
      });
      await expect(second).rejects.toSatisfy(isWorkerBuildFailedError);
      expect(h.state.buildCalls.length).toBe(callsAfterFirst);
    } finally {
      h.state.failBuilds = false;
    }
  });

  test("a transport error is never recorded as a build failure — the next caller retries the build", async () => {
    setCommit("c1", "repo-f-v1", "F1");
    h.state.failTransport = true;
    try {
      // The blocking caller sees the raw infra error, not a named build
      // failure...
      const blocking = resolveWorkerSource({
        projectId: "prj_f",
        source: repoSource("/repos/f"),
        waitUntil,
      });
      await expect(blocking).rejects.toThrow("container transport disconnected");
      await expect(blocking).rejects.not.toSatisfy(isWorkerBuildFailedError);
    } finally {
      h.state.failTransport = false;
    }

    // ...and no failure marker was written, so the next (budgeted) caller
    // dispatches a real build instead of serving a bogus build-failed state.
    const callsAfterBlip = h.state.buildCalls.length;
    const recovered = await resolveWorkerSource({
      buildBudgetMs: 5_000,
      projectId: "prj_f",
      source: repoSource("/repos/f"),
      waitUntil,
    });
    expect(recovered.serveInfo).toMatchObject({ commitOid: "c1", status: "fresh" });
    expect(h.state.buildCalls.length).toBe(callsAfterBlip + 1);
  });

  test("a bare repo ref and the canonical default-masked ref share one build key", async () => {
    // The template's app refs omit exclude masks while defaultProjectWorkerRef
    // spells them out — resolveFileSource canonicalizes the default so both
    // hash to one key, or the deploy-time template seed would never match the
    // apps and every fresh project's first app click would pay a cold build.
    setCommit("c1", "repo-h-v1", "H1");
    await resolveWorkerSource({
      projectId: "prj_h",
      source: {
        files: {
          exclude: [".git/**", "node_modules/**", "dist/**", "build/**"],
          repoPath: "/repos/h",
          type: "repo",
        },
        options: { entryPoint: "worker.ts" },
      },
      waitUntil,
    });
    const callsAfterCanonical = h.state.buildCalls.length;
    // No masks AND no options at all — both defaults (exclude, entryPoint)
    // canonicalize before the key, so this still hits the same artifact.
    const bare = await resolveWorkerSource({
      projectId: "prj_h",
      source: { files: { repoPath: "/repos/h", type: "repo" } },
      waitUntil,
    });
    expect(bare.serveInfo).toMatchObject({ commitOid: "c1", status: "fresh" });
    expect(h.state.buildCalls.length).toBe(callsAfterCanonical);
  });

  test("runtime artifacts are project-scoped — one project's build never serves another", async () => {
    setCommit("c1", "repo-g-v1", "G1");
    await resolveWorkerSource({ projectId: "prj_g1", source: repoSource("/repos/g"), waitUntil });
    const callsAfterFirst = h.state.buildCalls.length;

    // Identical source + options, different project: a project-trusted
    // principal can influence its own builder sandbox's output, so the cache
    // must NOT answer across projects — prj_g2 pays its own build.
    const other = await resolveWorkerSource({
      projectId: "prj_g2",
      source: repoSource("/repos/g"),
      waitUntil,
    });
    expect(other.serveInfo).toMatchObject({ commitOid: "c1", status: "fresh" });
    expect(h.state.buildCalls.length).toBe(callsAfterFirst + 1);
  });

  test("inline loader-ready sources bypass the pipeline and carry no serve info", async () => {
    const resolved = await resolveWorkerSource({
      projectId: "prj_e",
      source: {
        files: { files: { "main.js": "export default {};" }, type: "inline" },
        options: { bundle: false, entryPoint: "main.js" },
      },
      waitUntil,
    });
    expect(resolved.serveInfo).toBeUndefined();
    expect(resolved.mainModule).toBe("main.js");
  });
});
