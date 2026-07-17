import { describe, expect, test, vi } from "vitest";
import type { DynamicWorkerSource } from "./schemas.ts";

// The serve-side resolve matrix: fresh vs stale fallbacks around the builder.
// The env is faked at the module seam worker-loader.ts actually uses —
// builder RPC, repo head/snapshot, and the KV cache — so these tests drive
// resolveWorkerSource exactly like the runner does.
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
  }
  const kv = new FakeKv();
  const state = {
    buildCalls: [] as string[],
    failBuilds: false,
    files: { "worker.ts": "v1" } as Record<string, string>,
    head: { branch: "main", commitOid: "c1", contentHash: "h1" },
  };
  const itxEnv = {
    BUILDER: {
      build: async (input: { buildKey: string; files: Record<string, string> }) => {
        state.buildCalls.push(input.buildKey);
        if (state.failBuilds) throw new Error("esbuild exploded");
        return {
          buildKey: input.buildKey,
          mainModule: "worker.js",
          modules: { "worker.js": `// build of ${input.files["worker.ts"]}` },
        };
      },
    },
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
  return { itxEnv, kv, state };
});

vi.mock("../../env.ts", () => ({ itxEnv: h.itxEnv }));

const { isWorkerBuildFailedError, resolveWorkerSource } = await import("./worker-loader.ts");

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
