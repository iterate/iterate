import { expect, test } from "vitest";
import type { StreamEventInput } from "iterate/processors";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
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

const PING = "events.iterate.test/facet-version/ping";
const SEEN = "events.iterate.test/facet-version/seen";
const WOKEN = "events.iterate.com/stream/woken";

const PROBE_PATH = "version-probe.js";
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

    type Answer = { id: string; bootId: string; buildKey: string; revision: string };
    const answers = async (): Promise<Answer[]> => {
      const events = await stream.getEvents({ eventTypes: [SEEN] });
      return events.map((event) => event.payload as Answer);
    };

    /** Ping the facet and return the answer it committed. */
    const identify = async (label: string, timeoutMs: number): Promise<Answer> => {
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
    const afterCommitAnswers: Answer[] = [];
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
 * The probe facet, committed to the project's config repo. Plain JavaScript
 * (the platform bundles it; TS syntax fails the build as a
 * `subscription-delivery-halted` event) — so `#private` fields and plain
 * assignment instead of type annotations.
 *
 * It owes no background work, so `recovery` stays off: this probe is about
 * facet IDENTITY across incarnations, and a keepalive alarm would add a second
 * thing that revives the facet.
 */
const probeFacetSource = (revision: string) => `
import { StreamProcessorFacet } from "iterate/sdk";
import { defineProcessorContract, StreamProcessor } from "iterate/processors";
import { z } from "zod";

export const VersionProbeContract = defineProcessorContract({
  slug: "facet-version",
  version: "1.0.0",
  description: "Reports which facet instance and which loaded build handled each ping.",
  stateSchema: z.object({ seen: z.array(z.string()).default([]) }),
  events: {
    "${PING}": {
      description: "Ask the facet to identify itself.",
      payloadSchema: z.object({ id: z.string() }),
    },
    "${SEEN}": {
      description: "The answering facet instance, its build key, and its source revision.",
      payloadSchema: z.object({
        id: z.string(),
        bootId: z.string(),
        buildKey: z.string(),
        revision: z.string(),
      }),
    },
  },
  consumes: ["${PING}"],
  emits: ["${SEEN}"],
});

class VersionProbeProcessor extends StreamProcessor {
  contract = VersionProbeContract;
  // Set by the facet below, once per created processor.
  bootId = "unset";
  buildKey = "unset";

  reduce({ state, event }) {
    return { ...state, seen: [...state.seen, event.payload.id] };
  }

  processEvent({ event, append, blockProcessorWhile }) {
    if (event === null || event.type !== "${PING}") return;
    const id = event.payload.id;
    const bootId = this.bootId;
    const buildKey = this.buildKey;
    // Per-event work the cursor must not outrun: the answer IS the measurement.
    blockProcessorWhile(async () => {
      await append({
        type: "${SEEN}",
        idempotencyKey: "seen@" + id,
        // Baked into the SOURCE, so the answer says which build actually ran.
        payload: { id, bootId, buildKey, revision: "${revision}" },
      });
    });
  }
}

export class VersionProbeFacet extends StreamProcessorFacet {
  // One per FACET INSTANCE: a new value proves the facet was torn down and
  // started again (the base rebuilds its host per incarnation, but this field
  // lives on the Durable Object instance itself).
  #bootId = crypto.randomUUID();

  createProcessor(deps) {
    const processor = new VersionProbeProcessor(deps);
    processor.bootId = this.#bootId;
    // The build key the Stream DO resolved for this load — verbatim the
    // cacheKey half of the facetSourceVersion marker that drives the abort.
    processor.buildKey = String(this.env.ITERATE_WORKER_VERSION ?? "missing");
    return processor;
  }
}
`;

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
