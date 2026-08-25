import { expect, test } from "vitest";
import type { StreamEventInput } from "iterate/processors";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import {
  type FacetProbeAnswer,
  PING,
  PROBE_PATH,
  probeFacetSource,
  SEEN,
} from "./facet-version-probe.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

/*
 * Why the pin next door goes red for no reason.
 *
 * `userspace-facet-source-version.e2e.test.ts` is a `test.fails`: it asserts
 * the FIX ("a source commit reaches the RUNNING facet") and stays green only
 * while the bug survives. Its entire verdict is four comparisons between the
 * probe answer from before the commit and the one from after it:
 *
 *     revision === "v2" && buildKey !== before.buildKey
 *       && /^[0-9a-f]{64}$/.test(buildKey) && bootId !== before.bootId
 *
 * None of those says WHY the facet changed. A facet that recycles for its own
 * reasons — eviction, a redeploy rolling the isolate, a crash — comes back
 * building the newest source, because a facet that starts cold always does. So
 * a recycle that happens to land inside the pin's 45s poll window produces all
 * four, the pinned expectation passes, and vitest turns that into
 * `Error: Expect test to fail`. That has cost at least five red CI runs:
 * several during #2512, then #2516 at `1906b2aee` and again at `9bc655d82`
 * (Depot run 97mhddbj6d, job 7dm8bqj38b — 1 failed / 202 passed / 1 expected
 * fail, the failure being only the pin).
 *
 * So this test stops waiting for the coincidence and CAUSES it: commit the new
 * source, then kill the stream, so the facet that answers is provably a fresh
 * one and provably not a running facet that picked the commit up. The pin's
 * four comparisons should not all hold on that answer. They all hold.
 *
 * Note what the fix cannot be: a cleverer comparison over these same two
 * answers. A real in-place rebuild lands on a new boot id too (the abort
 * REPLACES the facet), so the recycle and the fix are the same tuple. On
 * seeing a new boot id the pin has to go back and re-probe for evidence that
 * the commit is what replaced the facet. That is a separate change; this test
 * only holds the bug still.
 */
test.fails(
  "the source-version pin tells a facet that recycled from one the commit rebuilt",
  // Ceiling for the cold facet build, the post-kill rebuild, and their pings.
  // The expected run is ~30-60s.
  { timeout: 150_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects
      .get(`facet-recycle-${crypto.randomUUID().slice(0, 8)}`)
      .create({});
    await project.projectId;

    const streamPath = "/facet-recycle";
    const subscriptionName = "facet-recycle";

    await project.repo.commitFiles({
      changes: [{ content: probeFacetSource("v1"), path: PROBE_PATH }],
      message: "A userspace facet processor that reports its instance, build key and revision",
    });

    const stream = project.streams.get(streamPath);

    await stream.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        name: subscriptionName,
        receiver: {
          action: "facet-processor",
          source: {
            kind: "userspace",
            worker: {
              type: "stateful",
              path: streamPath,
              className: "VersionProbeFacet",
              durableWorkerKey: "version-probe",
              source: {
                createWorker: {
                  entryPoint: PROBE_PATH,
                  files: { type: "repo", repoPath: "/repos/config" },
                },
              },
            },
          },
        },
      },
    } satisfies StreamEventInput);

    const answers = async (): Promise<FacetProbeAnswer[]> => {
      const events = await stream.getEvents({ eventTypes: [SEEN] });
      return events.map((event) => event.payload as FacetProbeAnswer);
    };

    /** Ping the facet and return the answer it committed. */
    const identify = async (label: string, timeoutMs: number): Promise<FacetProbeAnswer> => {
      const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
      await stream.append({ type: PING, payload: { id } } satisfies StreamEventInput);
      await waitForCondition(async () => (await answers()).some((answer) => answer.id === id), {
        description: `the userspace facet to answer ping "${id}"`,
        timeoutMs,
      });
      const answer = (await answers()).find((entry) => entry.id === id);
      if (answer === undefined) throw new Error(`no answer for ping "${id}"`);
      return answer;
    };

    // The facet the commit below will not reach: cold-built from v1, running.
    const beforeCommit = await identify("before-commit", 90_000);
    expect(beforeCommit).toMatchObject({ revision: "v1" });

    await project.repo.commitFiles({
      changes: [{ content: probeFacetSource("v2"), path: PROBE_PATH }],
      message: "Change the probe facet's source",
    });

    // THE COINCIDENCE, forced. In CI this is an eviction or a redeploy landing
    // inside the pin's poll window; here it is a kill, which is the same event
    // as far as the facet is concerned — the parent incarnation goes and takes
    // the facet with it. Nothing about the commit caused it.
    await stream.kill().catch(() => undefined);

    // Its replacement cold-builds, hence the cold-build budget. Polling rather
    // than pinging once is also what keeps THIS test from becoming the next
    // false alarm: every way of not reaching the pin's four comparisons ends
    // in a throw, which `test.fails` absorbs. The only way it can go red is by
    // reaching the bottom and finding the bug gone.
    const deadline = Date.now() + 60_000;
    let recycled = await identify("after-recycle-0", 90_000);
    for (let attempt = 1; recycled.revision !== "v2"; attempt++) {
      if (Date.now() > deadline) {
        throw new Error(`the restarted facet never built v2: ${JSON.stringify(recycled)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      recycled = await identify(`after-recycle-${attempt}`, 60_000);
    }

    // Ground truth, and the whole point: this is a NEW facet. It was created
    // after the kill, it never ran the v1 build, and no running facet ever
    // picked the commit up.
    expect(recycled).not.toMatchObject({ bootId: beforeCommit.bootId });

    console.log("facet recycle false alarm", { beforeCommit, recycled });

    // The pin's verdict, its four comparisons verbatim (the block under
    // "THE BUG" in userspace-facet-source-version.e2e.test.ts), applied to a
    // facet that demonstrably did not rebuild in place. One of them has to be
    // the one that notices. None is — and the fourth is worse than blind: a
    // moved boot id is the very thing that PROVES this was a recycle, and the
    // pin reads it as evidence for the rebuild.
    const pinVerdict = {
      revisionIsNewSource: recycled.revision === "v2",
      buildKeyMoved: recycled.buildKey !== beforeCommit.buildKey,
      buildKeyWellFormed: /^[0-9a-f]{64}$/.test(recycled.buildKey),
      bootIdMoved: recycled.bootId !== beforeCommit.bootId,
    };
    expect(pinVerdict).not.toMatchObject({
      revisionIsNewSource: true,
      buildKeyMoved: true,
      buildKeyWellFormed: true,
      bootIdMoved: true,
    });
  },
);
