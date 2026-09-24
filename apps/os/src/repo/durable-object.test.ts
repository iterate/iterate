// src/repo/durable-object.test.ts — THE READ AT A COMMIT is one fetch however many callers ask at once
// (`RepoDurableObject#fresh`): a commit's files never change, so every concurrent
// `modules({ commitOid })` waits on the one read in flight, and a read that fails leaves nothing
// behind for the next caller. The facet runs in Node against the e2e's fake git remote
// (e2e/support/fake-artifacts.ts), which speaks the real wire and counts the packs it served; the
// whole repo story is e2e/repos.e2e.test.ts.

import { expect, onTestFinished, test, vi } from "vitest";
import { FakeArtifacts } from "../../e2e/support/fake-artifacts.ts";
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

/** The repo facet on `path`, created, reaching `artifacts` as its context's `itx.cfArtifacts`. */
function repoFacet(artifacts: FakeArtifacts): RepoDurableObject {
  const ctx = {
    props: {
      iterateContextName: DurableObjectNameCodec.stringify({ projectId: "prj_repo", path }),
    },
  } as unknown as DurableObjectState;
  const repo = new RepoDurableObject(ctx, {
    ITX: { get: () => ({ cfArtifacts: artifacts }) },
  } as never);
  vi.spyOn(repo, "snapshot").mockResolvedValue({
    offset: 1,
    state: { creation: { status: "created", offset: 1 } },
  } as never);
  return repo;
}
