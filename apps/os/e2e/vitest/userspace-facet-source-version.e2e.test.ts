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
 * DELIBERATELY `test.fails`, in the sense `guarantees-not-given.test.ts` uses
 * it: the second half of this contract is BROKEN today, so the test passes
 * while the bug exists and starts failing the moment somebody fixes it. That
 * is the alert to delete `.fails`, not a reason to weaken the assertion.
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
 * AND ONE FALSE ALARM, so the next reader checks before celebrating: on
 * 2026-08-20 this pin flipped red in a preview run and the `.fails` was
 * briefly deleted — but that run's probe showed the after-commit answer on a
 * NEW bootId. The facet had coincidentally recycled between the commit and
 * the poll, and a restarted facet legitimately builds the new source; the
 * very next run was back to 16 same-boot polls on the old key. Before
 * believing this bug fixed, check the probe: the claim is only about a
 * SAME-BOOT facet, and only same-boot evidence refutes it. Every red run
 * since has been the same coincidence, and the four comparisons below
 * cannot see it: `userspace-facet-recycle-false-alarm.e2e.test.ts` forces
 * the recycle instead of waiting for it and pins that blind spot.
 */
test.fails(
  "a userspace facet rebuilds on a source commit and only on a source commit",
  // Ceiling for two cold facet builds plus four ping round-trips across two
  // kills. The expected run is ~40-90s.
  { timeout: 180_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects
      .get(`facet-version-${crypto.randomUUID().slice(0, 8)}`)
      .create({});
    await project.projectId;

    const streamPath = "/facet-version";
    const subscriptionName = "facet-version";

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

    // ---- Half two: a source commit MUST move it ---------------------------
    const repoKeyBefore = await resolvedRepoBuildKey();
    await project.repo.commitFiles({
      changes: [{ content: probeFacetSource("v2"), path: PROBE_PATH }],
      message: "Change the probe facet's source",
    });
    // The commit landed — so anything stale below is the worker source
    // resolution, not the repo write.
    expect((await project.repo.readFile({ path: PROBE_PATH }))?.content).toContain(
      'revision: "v2"',
    );

    // Poll rather than ping once: a rebuild that merely LAGS the commit is a
    // different (and much milder) thing than one that never happens, and only
    // a repeated ping tells them apart.
    const afterCommitAnswers: FacetProbeAnswer[] = [];
    const deadline = Date.now() + 45_000;
    let afterCommit = await identify("after-commit-0", 90_000);
    afterCommitAnswers.push(afterCommit);
    for (let attempt = 1; afterCommit.revision !== "v2" && Date.now() < deadline; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      afterCommit = await identify(`after-commit-${attempt}`, 60_000);
      afterCommitAnswers.push(afterCommit);
    }

    // Diagnostic discriminator, not the contract: a kill guarantees a facet
    // built from a freshly resolved class. If THAT answers v2 while the polls
    // above never did, the build key did move and the abort simply failed to
    // replace the facet; if it also answers v1, the source resolution never saw
    // the commit at all.
    const repoKeyAfter = await resolvedRepoBuildKey();

    await stream.kill().catch(() => undefined);
    const afterKill = await identify("after-kill", 90_000);
    console.log("facet source-version probe", {
      first,
      third,
      repoKeyBefore,
      repoKeyAfter,
      afterCommitPolls: afterCommitAnswers.length,
      afterCommitLast: afterCommitAnswers.at(-1),
      afterKill,
    });

    // The source resolution DID see the commit — so anything stale below is the
    // facet lifecycle, not the repo or the build cache.
    expect(repoKeyAfter).not.toBe(repoKeyBefore);
    // ...and a restarted parent builds the new class, so the new source is
    // loadable and the class name still resolves.
    expect(afterKill).toMatchObject({ revision: "v2" });

    // THE BUG (red as of 2026-08-10, measured on os-preview-3): the running
    // facet never picks the commit up. Every poll above was answered by the
    // same facet instance running the pre-commit build, for as long as the
    // parent incarnation lives — and a Stream DO holding a socket does not
    // hibernate, so "as long as it lives" can be indefinitely.
    expect(afterCommit).toMatchObject({ revision: "v2" });
    expect(afterCommit).not.toMatchObject({ buildKey: first.buildKey });
    expect(afterCommit.buildKey).toMatch(/^[0-9a-f]{64}$/);
    expect(afterCommit).not.toMatchObject({ bootId: third.bootId });
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
