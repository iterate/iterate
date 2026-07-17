import { expect, test } from "vitest";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

// The fetch lane's availability contract end to end: once a worker has built
// successfully, browsers never see a broken project host again — a new
// commit serves the previous build while it builds (or after its build
// fails, with the failure on the serve header), and a fixing commit heals
// without intervention. Also proves the @iterate overlay actually lands in
// project HTML (HTMLRewriter is workerd-only, so this cannot be unit-tested).
test(
  "project host serves the previous build through a broken commit, with serve info and overlay",
  { timeout: 240_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({ slug: `stale-serve-${crypto.randomUUID().slice(0, 8)}` });
    const { projectId } = await project.__describe();

    type Serve = {
      commitOid?: string;
      failure?: { commitOid?: string; message: string };
      reason?: string;
      status: string;
    };
    const fetchHome = async () => {
      const response = await fetch(buildUrl({ path: `/${projectId}` }));
      const raw = response.headers.get("x-iterate-worker-serve");
      return { response, serve: raw === null ? null : (JSON.parse(raw) as Serve) };
    };
    // All four polled phases share ONE deadline inside the heavy-test budget
    // (240s ceiling — scripts/preview/e2e-policy.test.ts): a slow cold build
    // gets whatever the fast phases didn't use, and a wedged phase fails with
    // this crafted message instead of a bare vitest timeout.
    const testDeadline = Date.now() + 220_000;
    const pollHome = async (
      accept: (result: Awaited<ReturnType<typeof fetchHome>>) => boolean,
      what: string,
    ) => {
      for (;;) {
        const result = await fetchHome();
        if (accept(result)) return result;
        if (Date.now() > testDeadline) {
          throw new Error(
            `never saw ${what}; last: ${result.response.status} ${JSON.stringify(result.serve)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    };

    // A healthy project host: fresh serve info at a commit, overlay injected.
    const fresh = await pollHome(({ response, serve }) => {
      return response.status === 200 && serve?.status === "fresh";
    }, "a fresh 200");
    expect(fresh.serve?.commitOid).toBeTruthy();
    const homepage = await fresh.response.text();
    expect(homepage).toContain("Hello from your Iterate project worker");
    // The overlay script is appended inside the body by HTMLRewriter.
    expect(homepage).toContain("__iterateWorkerOverlay");
    expect(homepage.indexOf("__iterateWorkerOverlay")).toBeGreaterThan(homepage.indexOf("<body"));

    const original = await project.repo.readFile({ path: "worker.ts" });
    expect(original?.content).toContain("export default class ProjectWorker");

    // Break the build. The host must keep answering 200 from the previous
    // build — first marked "building", then "build-failed" once the failure
    // is on record — and the old page keeps rendering throughout.
    await project.repo.commitFiles({
      changes: [{ path: "worker.ts", content: "this is not valid typescript ((((" }],
      message: "break the worker build",
    });
    const stale = await pollHome(({ response, serve }) => {
      return response.status === 200 && serve?.status === "stale";
    }, "a stale 200");
    expect(["building", "build-failed"]).toContain(stale.serve?.reason);
    expect(await stale.response.text()).toContain("Hello from your Iterate project worker");

    const failed = await pollHome(({ serve }) => serve?.reason === "build-failed", "build-failed");
    expect(failed.response).toMatchObject({ status: 200 });
    expect(failed.serve?.failure?.message).toBeTruthy();

    // A fixing commit heals the host without any intervention.
    await project.repo.commitFiles({
      changes: [{ path: "worker.ts", content: original!.content }],
      message: "fix the worker build",
    });
    const healed = await pollHome(({ response, serve }) => {
      return response.status === 200 && serve?.status === "fresh";
    }, "a healed fresh 200");
    expect(await healed.response.text()).toContain("Hello from your Iterate project worker");
  },
);
