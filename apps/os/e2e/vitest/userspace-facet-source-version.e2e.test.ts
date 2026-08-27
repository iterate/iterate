import { expect } from "vitest";
import { failingTest } from "@iterate-com/shared/test-support/failing-test";
import type { StreamEventInput } from "iterate/processors";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import {
  type FacetProbeAnswer,
  PING,
  PROBE_CONTRACT_SLUG,
  PROBE_PATH,
  probeFacetSource,
  SEEN,
} from "./facet-version-probe.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// The source-change contract for a userspace processor FACET, in both
// directions.
//
// `#dialProcessorFacet` calls `#abortFacetOnVersionChange` before every
// `ctx.facets.get`. The marker it compares is `{ className, cacheKey }`, where
// `cacheKey` is the dynamic worker's content-addressed build key, so the whole
// lifecycle rests on that key: identical for unchanged source (or every wake
// kills the facet, taking its in-memory state and in-flight work with it), and
// different after a source commit (or the facet keeps serving stale code
// forever, because `ctx.facets.get` reuses a running facet and ignores the new
// startup class).
//
// Only a real deployment can answer this: the key comes from the repo Durable
// Object's head record and the KV artifact store, neither of which a unit test
// observes. The facet reports its own key — worker-loader.ts publishes it into
// the loaded isolate's env as `ITERATE_WORKER_VERSION`, verbatim the `cacheKey`
// half of the marker — plus a per-instance boot id and the source revision it
// was built from.

const WOKEN = "events.iterate.com/stream/woken";

const ECHO_PATH = "version-echo.js";

/*
 * A PINNED BUG, held by `failingTest`: the body asserts the desired contract,
 * and while the bug exists it must fail with the SAME-BOOT STALENESS error
 * the wrapper matches. The moment somebody fixes the bug, the body succeeds
 * and the wrapper goes red with delete-me instructions.
 *
 * What is broken, reproduced 5/5 against a real deployment: a RUNNING
 * userspace facet never picks up a source commit. `resolveWorkerSource` sees
 * the new revision immediately — a stateless echo worker on the same repo
 * moves build keys at once — while the facet answers 15-172 consecutive
 * deliveries over 45s from the same boot id, on the same old key, running the
 * old code. One `stream.kill()` and it comes back rebuilt.
 *
 * `ctx.facets.get` reuses a running facet and ignores the startup class, and
 * `ctx.facets.abort` does not make it let go within the parent's incarnation.
 * For a stream that never hibernates — and an open outbound WebSocket blocks
 * hibernation, which is exactly what a live voice call holds — "the life of
 * the incarnation" is indefinite, so a config-repo commit silently does
 * nothing. Two fixes were deployed and measured against this test (abort plus
 * a scheduler yield; marker write plus abort plus storage sync plus
 * `this.ctx.abort()`); neither worked, and both were reverted rather than
 * shipped on hope.
 *
 * History: this pin used to be a bare `test.fails` and false-alarmed red 7+
 * times (quarantined 2026-08-27, tasks/platform-stall-repros.md thread 5) —
 * a facet that coincidentally recycled inside the poll window legitimately
 * builds the new source, which the old four comparisons could not tell from
 * a real fix. The rounds below make the coincidence inconclusive instead of
 * conclusive: only SAME-BOOT evidence ends the test in either direction. A
 * recycle mid-round just starts a fresh round against the new boot;
 * `userspace-facet-recycle-false-alarm.e2e.test.ts` next door still pins the
 * old blind spot mechanically.
 */
failingTest(
  {
    failure: /SAME-BOOT STALENESS/,
    // Ceiling for the cold build, the two stability kills, and up to three
    // 45s observation rounds. The expected run (bug present, no recycles)
    // is ~60-110s.
    timeout: 240_000,
  },
  "a userspace facet rebuilds on a source commit and only on a source commit",
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects
      .get(`facet-version-${crypto.randomUUID().slice(0, 8)}`)
      .create({});
    await project.projectId;

    const streamPath = "/facet-version";
    // Must equal the probe contract's slug: a facet-processor subscription
    // named anything else is silently delivered nothing.
    const subscriptionName = PROBE_CONTRACT_SLUG;

    await project.repo.commitFiles({
      changes: [
        { content: probeFacetSource("v1"), path: PROBE_PATH },
        { content: versionEchoSource, path: ECHO_PATH },
      ],
      message: "A userspace facet processor that reports its instance, build key and revision",
    });

    /** What `resolveWorkerSource` yields for this repo, right now. */
    const resolvedRepoBuildKey = async (): Promise<string> => {
      using echo = project.workers.get({
        entrypoint: "VersionEcho",
        path: "/",
        source: {
          createWorker: {
            entryPoint: ECHO_PATH,
            files: { type: "repo", repoPath: "/repos/config" },
          },
        },
        type: "stateless",
      }) as unknown as { version(): Promise<string> } & Disposable;
      return await echo.version();
    };

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
      await waitForCondition(
        async () => (await answers()).some((answer) => answer.id === id),
        // A build failure surfaces as a `subscription-delivery-halted` event on
        // the stream — read it if this ever times out.
        { description: `the userspace facet to answer ping "${id}"`, timeoutMs },
      );
      const answer = (await answers()).find((entry) => entry.id === id);
      if (answer === undefined) throw new Error(`no answer for ping "${id}"`);
      return answer;
    };

    // First contact forces the cold build and starts the facet.
    const first = await identify("first", 90_000);
    expect(first).toMatchObject({ revision: "v1" });
    expect(first.buildKey).toMatch(/^[0-9a-f]{64}$/);

    // ---- Half one: unchanged source must NOT move the marker ---------------
    // Kill the Stream DO. The parent incarnation and its facet both go; the
    // next append boots a fresh incarnation, which re-resolves the source and
    // re-runs `#abortFacetOnVersionChange` against the stored marker.
    await stream.kill().catch(() => undefined);
    const second = await identify("second", 60_000);

    await stream.kill().catch(() => undefined);
    const third = await identify("third", 60_000);

    // Non-vacuity: the kills really did cross facet lifetimes. Without this a
    // warm facet answering all three pings would make the assertion below pass
    // for free.
    expect(new Set([first.bootId, second.bootId, third.bootId]).size).toBeGreaterThan(1);
    // Evidence that these were genuinely separate parent incarnations.
    expect((await stream.getEvents({ eventTypes: [WOKEN] })).length).toBeGreaterThanOrEqual(3);

    // The source never changed, so the build key — and with it the
    // `facetSourceVersion:<name>` marker — must be one value across every
    // incarnation. Anything else means the abort fires on unchanged source.
    expect(second).toMatchObject({ buildKey: first.buildKey });
    expect(third).toMatchObject({ buildKey: first.buildKey });

    // ---- Half two: a source commit MUST reach the RUNNING facet -----------
    // Rounds, because a coincidental recycle (deploy, eviction) can mask the
    // bug for one observation: a restarted facet always builds the newest
    // source, which proves nothing about the running-facet contract. Each
    // round commits a fresh revision and watches the facet that is running
    // right now; only SAME-BOOT evidence ends the test. Same-boot pickup →
    // the bug is fixed (return; the wrapper alerts). Same-boot staleness
    // past the deadline → the pinned error. A changed boot id → the round
    // proved nothing, run another against the new boot.
    let revision = 1;
    for (let round = 1; round <= 3; round++) {
      const baseline = await identify(`round-${round}-baseline`, 90_000);
      const repoKeyBefore = await resolvedRepoBuildKey();
      revision += 1;
      const committed = `v${revision}`;
      await project.repo.commitFiles({
        changes: [{ content: probeFacetSource(committed), path: PROBE_PATH }],
        message: `Change the probe facet's source (round ${round})`,
      });
      // The commit landed and the source resolution sees it — so staleness
      // below is the facet lifecycle, not the repo write or the build cache.
      expect((await project.repo.readFile({ path: PROBE_PATH }))?.content).toContain(
        `revision: "${committed}"`,
      );
      expect(await resolvedRepoBuildKey()).not.toBe(repoKeyBefore);

      // Poll rather than ping once: a rebuild that merely LAGS the commit is
      // a different (and much milder) thing than one that never happens.
      const deadline = Date.now() + 45_000;
      let sameBootPolls = 0;
      let recycled = false;
      while (!recycled) {
        const answer = await identify(`round-${round}-poll-${sameBootPolls}`, 60_000);
        if (answer.bootId !== baseline.bootId) {
          recycled = true;
          break;
        }
        sameBootPolls += 1;
        if (answer.revision === committed) {
          // Same-boot pickup: the running facet took the commit. Also check
          // the marker really moved before declaring victory.
          expect(answer).not.toMatchObject({ buildKey: baseline.buildKey });
          expect(answer.buildKey).toMatch(/^[0-9a-f]{64}$/);
          return;
        }
        if (Date.now() >= deadline) {
          // Discriminator before concluding: a kill guarantees a facet built
          // from a freshly resolved class. If even THAT is stale, the source
          // resolution is broken — a different bug, reported with a
          // non-matching error so the wrapper turns it red.
          await stream.kill().catch(() => undefined);
          const afterKill = await identify(`round-${round}-after-kill`, 90_000);
          if (afterKill.revision !== committed) {
            throw new Error(
              `source resolution never saw the commit: a freshly built facet still serves ` +
                `${afterKill.revision} after committing ${committed}`,
            );
          }
          throw new Error(
            `SAME-BOOT STALENESS: facet boot ${answer.bootId} answered ${sameBootPolls} polls ` +
              `over 45s still serving ${answer.revision} on buildKey ${answer.buildKey.slice(0, 8)}… ` +
              `after committing ${committed} (a fresh facet serves it fine)`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
    throw new Error(
      "INCONCLUSIVE: the facet recycled mid-round in all 3 rounds — same-boot behavior was never observable",
    );
  },
);

/**
 * A STATELESS worker off the same repo. It holds no facet and caches nothing,
 * so every call re-runs `resolveWorkerSource` and reports the build key that
 * resolution produces right now — the parent-side truth the facet cannot see.
 */
const versionEchoSource = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class VersionEcho extends WorkerEntrypoint {
  async version() {
    return String(this.env.ITERATE_WORKER_VERSION);
  }
}
`;
