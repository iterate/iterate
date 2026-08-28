import { expect, test } from "vitest";
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

// The source-change contract for a userspace processor FACET — the
// deterministic parts.
//
// `#dialProcessorFacet` calls `#abortFacetOnVersionChange` before every
// `ctx.facets.get`. The marker it compares is `{ className, cacheKey }`, where
// `cacheKey` is the dynamic worker's content-addressed build key, so the whole
// lifecycle rests on that key: identical for unchanged source (or every wake
// kills the facet, taking its in-memory state and in-flight work with it), and
// different after a source commit. Only a real deployment can answer this: the
// key comes from the repo Durable Object's head record and the KV artifact
// store, neither of which a unit test observes. The facet reports its own key —
// worker-loader.ts publishes it into the loaded isolate's env as
// `ITERATE_WORKER_VERSION` — plus a per-instance boot id and the source
// revision it was built from.
//
// Three assertions, all deterministic:
//  1. Unchanged source keeps ONE build key across parent incarnations
//     (two kills, three facet lifetimes, one key).
//  2. A source commit moves `resolveWorkerSource` immediately — proven by a
//     stateless echo worker on the same repo, which caches nothing.
//  3. A facet built AFTER the commit (the kill forces one) serves the
//     committed revision: resolution, build cache, and the startup class
//     agree end to end.
//
// What this test deliberately does NOT assert: whether a commit reaches a
// facet that is ALREADY RUNNING. That behavior is a race, with both outcomes
// observed on one deployment minutes apart (preview-9, 2026-08-28, Depot run
// 4pfjnjw0gn: attempt 1 replaced the running facet promptly after every
// commit; attempt 2 had a facet serve stale code for 45s+). The marker abort
// always fires — server logs show `stream facet source changed; aborting`
// commit-correlated every time — but whether `ctx.facets.get` then reattaches
// the aborted-but-running facet or builds fresh is decided inside workerd.
// This file used to hold a `failing(test, /SAME-BOOT STALENESS/)` pin on the
// stale side of that race; a racy bug cannot be pinned (the pin flip-flopped
// exactly as often as the race resolved the other way), so the pin was
// removed. The bug is real and tracked: tasks/facet-commit-pickup-race.md.

const WOKEN = "events.iterate.com/stream/woken";

const ECHO_PATH = "version-echo.js";

test(
  "a facet keeps one build key while its source is unchanged and rebuilds from a commit on restart",
  // Ceiling, not an expectation: cold build plus three kills lands around
  // 60-90s against a busy preview.
  { timeout: 240_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects
      .get(`facet-version-${crypto.randomUUID().slice(0, 8)}`)
      .create({});
    await project.projectId;

    const streamPath = "/facet-version";
    // Must equal the probe contract's slug: a facet-processor subscription
    // named anything else is silently delivered nothing — no error, no
    // halted-delivery event, just a facet that never answers.
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
      // A ping issued just after a kill can land while the Durable Object is
      // still being reset. That is the platform, not the measurement, so give
      // the append a few goes before giving up on the whole run.
      for (let attempt = 0; ; attempt++) {
        try {
          await stream.append({ type: PING, payload: { id } } satisfies StreamEventInput);
          break;
        } catch (error) {
          if (attempt === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
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
    const first = await identify("first", 120_000);
    expect(first).toMatchObject({ revision: "v1" });
    expect(first.buildKey).toMatch(/^[0-9a-f]{64}$/);

    // ---- Unchanged source must NOT move the marker --------------------------
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

    // ---- A commit must reach the next facet build ---------------------------
    const repoKeyBefore = await resolvedRepoBuildKey();
    await project.repo.commitFiles({
      changes: [{ content: probeFacetSource("v2"), path: PROBE_PATH }],
      message: "Change the probe facet's source",
    });
    // The commit landed and source resolution sees it immediately — so a stale
    // facet below would be the facet lifecycle, not the repo write or the
    // build cache.
    expect((await project.repo.readFile({ path: PROBE_PATH }))?.content).toContain(
      'revision: "v2"',
    );
    expect(await resolvedRepoBuildKey()).not.toBe(repoKeyBefore);

    // Force a fresh facet: the kill takes the parent incarnation and the
    // facet with it, and the replacement cold-builds from a fresh resolution.
    // (Whether the RUNNING facet would have picked the commit up is the race
    // documented above — not asserted here.)
    await stream.kill().catch(() => undefined);

    // The first pings after the kill can race the reset and be answered from
    // events delivered to the outgoing incarnation, so poll to the committed
    // revision rather than asserting the very first answer.
    const deadline = Date.now() + 60_000;
    let rebuilt = await identify("after-commit-0", 120_000);
    for (let attempt = 1; rebuilt.revision !== "v2"; attempt++) {
      if (Date.now() > deadline) {
        throw new Error(
          `a freshly built facet still serves ${rebuilt.revision} after committing v2 — ` +
            `source resolution or the build cache is broken: ${JSON.stringify(rebuilt)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      rebuilt = await identify(`after-commit-${attempt}`, 60_000);
    }

    // A new build of the new source, on a new facet instance.
    expect(rebuilt.buildKey).toMatch(/^[0-9a-f]{64}$/);
    expect(rebuilt).not.toMatchObject({ buildKey: first.buildKey });
    expect(rebuilt).not.toMatchObject({ bootId: third.bootId });
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
