// src/repo/durable-object.test.ts — THE READ AT A COMMIT is one fetch however many callers ask at once
// (`RepoDurableObject#fresh`): a commit's files never change, so every concurrent
// `modules({ commitOid })` waits on the one read in flight, and a read that fails leaves nothing
// behind for the next caller. THE GIT CREDENTIALS outlive an incarnation: a fresh one reuses the
// stored remote and a token with life left, and asks the binding for nothing. The facet runs in Node
// against the e2e's fake git remote (e2e/support/fake-artifacts.ts), which speaks the real wire and
// counts the packs it served; the whole repo story is e2e/repos.e2e.test.ts.

import { expect, onTestFinished, test, vi } from "vitest";
import { FakeArtifacts } from "../../e2e/support/fake-artifacts.ts";
import {
  projectScopedArtifacts,
  repoPathOf,
  type ArtifactRepoHandle,
  type ArtifactsNamespace,
} from "../context/cf-artifacts.ts";
import { DurableObjectNameCodec } from "../context/paths.ts";
import { RepoDurableObject } from "./durable-object.ts";

const path = "/repos/config";

test.for([
  { name: "50 concurrent reads at one commit fetch its pack once", callers: 50, failFirst: false },
  {
    name: "a read that fails fails its 5 waiters together; the next read fetches again and answers",
    callers: 5,
    failFirst: true,
  },
])("$name", async ({ callers, failFirst }) => {
  const artifacts = await FakeArtifacts.start({ [path]: { "worker.ts": "export default 1;\n" } });
  onTestFinished(() => artifacts.close());
  const commitOid = artifacts.remoteTip(path)!;
  const realFetch = globalThis.fetch;
  let failNext = failFirst;
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
    if (!failNext) return realFetch(...args);
    failNext = false;
    return Promise.reject(new Error("Artifacts answered 503"));
  });
  onTestFinished(() => void vi.unstubAllGlobals());
  const repo = repoFacet(artifacts);

  const wave = await Promise.allSettled(
    Array.from({ length: callers }, () => repo.modules({ commitOid })),
  );
  const next = await repo.modules({ commitOid });

  expect(wave.map((outcome) => outcome.status)).toEqual(
    Array(callers).fill(failFirst ? "rejected" : "fulfilled"),
  );
  expect(next).toEqual({ "cap.js": "export default 1;\n" });
  // the fake remote counts only the packs it SERVED: a rejected fetch never reached it
  const packsServed = artifacts.snapshots;
  expect(packsServed).toBe(1);
});

test("a repo's first read asks the binding for its remote once and mints one token", async () => {
  const { artifacts, calls, cfArtifacts } = await countingArtifacts();
  expect(await repoFacet(cfArtifacts).modules()).toEqual({ "cap.js": "export default 1;\n" });
  expect(calls).toEqual({ get: 2, info: 1, createToken: 1 });
  expect(artifacts).toMatchObject({ snapshots: 1 });
});

test("a fresh incarnation reuses the stored remote and token: a cold load asks the binding for nothing", async () => {
  const { artifacts, calls, cfArtifacts } = await countingArtifacts();
  const storage = memoryStorage();
  await repoFacet(cfArtifacts, storage).modules();
  const warm = { ...calls };

  // A new object over the same storage: nothing in memory, the pack fetched again.
  expect(await repoFacet(cfArtifacts, storage).modules()).toEqual({
    "cap.js": "export default 1;\n",
  });
  expect(calls).toEqual(warm);
  expect(artifacts).toMatchObject({ snapshots: 2 });
});

test("a fresh incarnation whose stored token is inside the reuse margin mints one, with no remote asked", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  const { calls, cfArtifacts } = await countingArtifacts();
  const storage = memoryStorage();
  await repoFacet(cfArtifacts, storage).modules();
  calls.get = calls.info = calls.createToken = 0;

  // 300 s of life, reused until 60 s before its end
  vi.setSystemTime(Date.now() + 239_000);
  await repoFacet(cfArtifacts, storage).modules();
  expect(calls).toEqual({ get: 0, info: 0, createToken: 0 });
  vi.setSystemTime(Date.now() + 2_000);
  await repoFacet(cfArtifacts, storage).modules();
  expect(calls).toEqual({ get: 1, info: 0, createToken: 1 });
});

/** The repo facet on `path`, created, reaching `cfArtifacts` as its context's `itx.cfArtifacts`, over
 *  `storage` — its durable storage, which a second facet over the same one finds as a fresh
 *  incarnation does. */
function repoFacet(cfArtifacts: unknown, storage = memoryStorage()): RepoDurableObject {
  const ctx = {
    props: {
      iterateContextName: DurableObjectNameCodec.stringify({ projectId: "prj_repo", path }),
    },
    storage,
  } as unknown as DurableObjectState;
  const repo = new RepoDurableObject(ctx, {
    ITX: { get: () => ({ cfArtifacts }) },
  } as never);
  vi.spyOn(repo, "snapshot").mockResolvedValue({
    offset: 1,
    state: { creation: { status: "created", offset: 1 } },
  } as never);
  return repo;
}

/** The async key-value half of `ctx.storage`, in memory: values copied in and out, as stored. */
function memoryStorage() {
  const stored = new Map<string, unknown>();
  return {
    get: async (key: string) => structuredClone(stored.get(key)),
    put: async (key: string, value: unknown) => void stored.set(key, structuredClone(value)),
    delete: async (key: string) => stored.delete(key),
  };
}

/** The real proxy (`projectScopedArtifacts`) over a namespace that counts the binding's calls and
 *  hands out the fake remote's URL, reached as a facet reaches it through its context: every call on
 *  `get(path)`'s handle is a second dispatch, which walks `get(path)` again
 *  (packages/iterate/src/expression.ts). */
async function countingArtifacts() {
  const artifacts = await FakeArtifacts.start({ [path]: { "worker.ts": "export default 1;\n" } });
  onTestFinished(() => artifacts.close());
  const calls = { get: 0, info: 0, createToken: 0 };
  const namespace = {
    get: async (name: string) => {
      calls.get++;
      const remote = artifacts.get(repoPathOf(name.slice("prj_repo.".length))).remote();
      return {
        info: async () => {
          calls.info++;
          return { remote };
        },
        createToken: async () => {
          calls.createToken++;
          return { plaintext: "fake" };
        },
      } as unknown as ArtifactRepoHandle;
    },
  } as unknown as ArtifactsNamespace;
  const scope = projectScopedArtifacts({ namespace, projectId: "prj_repo" });
  const cfArtifacts = {
    get: (repoPath: string) => {
      void scope.get(repoPath);
      return {
        remote: async () => (await scope.get(repoPath)).remote(),
        createToken: async (tokenScope: "read" | "write", ttlSeconds: number) =>
          (await scope.get(repoPath)).createToken(tokenScope, ttlSeconds),
      };
    },
  };
  return { artifacts, calls, cfArtifacts };
}
