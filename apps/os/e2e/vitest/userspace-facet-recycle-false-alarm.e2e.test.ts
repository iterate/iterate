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
 * Why the adjacent pin goes red for no reason.
 *
 * `userspace-facet-source-version.e2e.test.ts` is a `test.fails`: it asserts
 * the FIX ("a source commit reaches the RUNNING facet"), so it stays green
 * only while the bug survives and goes red the moment somebody fixes it. Its
 * whole verdict is four comparisons between the probe answer from before the
 * commit and the one from after it:
 *
 *     revision === "v2" && buildKey !== before.buildKey
 *       && /^[0-9a-f]{64}$/.test(buildKey) && bootId !== before.bootId
 *
 * None of them says WHY the facet changed. A facet that recycles for its own
 * reasons — eviction, a redeploy rolling the isolate, a crash — comes back
 * building the newest source, because a facet that starts cold always does. So
 * a recycle that happens to land inside the pin's 45s poll window produces all
 * four, the pinned expectation passes, and vitest turns that into
 * `Error: Expect test to fail`.
 *
 * It is not rare. The pin false-alarmed on the preview run of the very PR that
 * added this file, and printed the proof: `third` answered v1 on boot
 * `7c3831dc` and the FIRST poll after the commit answered v2 on boot
 * `20bc97b2`. The facet had recycled in between, so the pin never observed a
 * running facet at all.
 *
 * This test therefore stops waiting for the coincidence and CAUSES it: commit
 * the new source, then kill the stream, so the facet that answers is provably
 * a fresh one and provably not a running facet that picked the commit up. The
 * pin's four comparisons should not all hold on that answer. They all hold.
 *
 * Note what the fix cannot be: a cleverer comparison over these same two
 * answers. A real in-place rebuild lands on a new boot id too (the abort
 * REPLACES the facet), so the recycle and the fix are the same tuple. On
 * seeing a new boot id the pin has to go back and re-probe for evidence that
 * the commit is what replaced the facet. That is a separate change; this test
 * only holds the bug still.
 *
 * Needs a real deployment, like the pin: against local dev the facet never
 * builds at all and the first ping times out, which `test.fails` absorbs into
 * a vacuous pass. Hence the `[facet-recycle]` phase log — `test.fails` hides
 * WHICH throw ended the run, so a run that proves anything is one whose log
 * reaches `verdict`.
 */
test.fails(
  "the source-version pin tells a facet that recycled from one the commit rebuilt",
  // Ceiling, not an expectation: the run is ~60-90s against an idle
  // deployment. 150s was not enough on a fully loaded preview run (the first
  // attempt of the run described above timed out), and a ceiling only costs
  // wall time when it is actually hit.
  { timeout: 240_000 },
  async () => {
    // `test.fails` reports every throw as the expected one, so the phase log
    // is the only way to tell a run that measured something from one that
    // fell over on the way. Every step announces itself.
    const log = (phase: string, detail?: unknown) =>
      console.log(`[facet-recycle] ${phase}`, detail ?? "");

    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects
      .get(`facet-recycle-${crypto.randomUUID().slice(0, 8)}`)
      .create({});
    log("project created", await project.projectId);

    const streamPath = "/facet-recycle";
    const subscriptionName = "facet-recycle";

    await project.repo.commitFiles({
      changes: [{ content: probeFacetSource("v1"), path: PROBE_PATH }],
      message: "A userspace facet processor that reports its instance, build key and revision",
    });
    log("committed v1");

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
    log("subscription configured");

    const answers = async (): Promise<FacetProbeAnswer[]> => {
      const events = await stream.getEvents({ eventTypes: [SEEN] });
      return events.map((event) => event.payload as FacetProbeAnswer);
    };

    /** Ping the facet and return the answer it committed. */
    const identify = async (label: string, timeoutMs: number): Promise<FacetProbeAnswer> => {
      const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
      // A ping issued just after a kill can land while the Durable Object is
      // still being reset. That is the platform, not the measurement, so give
      // the append a few goes before giving up on the whole run.
      for (let attempt = 0; ; attempt++) {
        try {
          await stream.append({ type: PING, payload: { id } } satisfies StreamEventInput);
          break;
        } catch (error) {
          if (attempt === 4) throw error;
          log(`ping "${id}" did not append, retrying`, String(error));
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
      await waitForCondition(async () => (await answers()).some((answer) => answer.id === id), {
        // A build failure surfaces as a `subscription-delivery-halted` event on
        // the stream — read it if this ever times out.
        description: `the userspace facet to answer ping "${id}"`,
        timeoutMs,
      });
      const answer = (await answers()).find((entry) => entry.id === id);
      if (answer === undefined) throw new Error(`no answer for ping "${id}"`);
      log(`answered ${label}`, answer);
      return answer;
    };

    // The facet the commit below will not reach: cold-built from v1, running.
    const beforeCommit = await identify("before-commit", 120_000);
    expect(beforeCommit).toMatchObject({ revision: "v1" });

    await project.repo.commitFiles({
      changes: [{ content: probeFacetSource("v2"), path: PROBE_PATH }],
      message: "Change the probe facet's source",
    });
    log("committed v2");

    // THE COINCIDENCE, forced. In CI this is an eviction or a redeploy landing
    // inside the pin's poll window; here it is a kill, which is the same event
    // as far as the facet is concerned — the parent incarnation goes and takes
    // the facet with it. Nothing about the commit caused it.
    await stream.kill().catch(() => undefined);
    log("killed the stream");

    // Its replacement cold-builds, hence the cold-build budget.
    const deadline = Date.now() + 60_000;
    let recycled = await identify("after-recycle-0", 120_000);
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

    log("verdict", { beforeCommit, recycled });

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
