import { expect, test } from "vitest";
import type { StreamEventInput } from "iterate/processors";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// A userspace stream processor, authored as ordinary project code and hosted
// as a FACET of the platform's Stream Durable Object (`facet-processor` with a
// `userspace` source), that owes a deliberately slow background side effect —
// then we KILL the Stream DO mid-work and prove the parent's alarm revives the
// facet and finishes the job.
//
// This exercises the whole userspace-facet path end to end:
//   1. the Stream DO loads the userspace class from the project's config repo
//      and starts it with `ctx.facets.get(name, …)` (the loader branch of
//      `#dialProcessorFacet`);
//   2. the facet has no native alarm (workerd#6810), so its registry keepalive
//      arms the parent's real platform alarm over itx — the `StreamProcessorFacet`
//      base dials `streams.get(path).proxySetAlarm`, the Option-A alarm proxy;
//   3. `stream.kill()` aborts the parent incarnation (and its facet) while the
//      slow attempt is still in flight;
//   4. the durable platform alarm the keepalive armed survives the abort, fires
//      in a fresh incarnation, and the parent replays it into the revived
//      facet's `handleAlarm` → recovery re-drives the still-open obligation
//      from committed stream evidence and appends the completion.
//
// The observation surface is the stream itself: a `…/started` event proves the
// attempt was in flight before the kill, and the `…/completed` event that only
// appears AFTER the kill proves revival continued the work.

const WORK_REQUESTED = "events.iterate.test/slow-work/requested";
const WORK_STARTED = "events.iterate.test/slow-work/started";
const WORK_COMPLETED = "events.iterate.test/slow-work/completed";

// "Somewhat slow": a real multi-second side effect — long enough that, once we
// see the attempt start (a `…/started` event, detected within a sub-second
// poll), we can kill the DO well before it would append `…/completed`, but no
// longer than it needs to be.
const SLOW_WORK_MS = 8_000;

/**
 * The userspace facet source, committed to the project's config repo. Plain
 * JavaScript (this is bundled by the platform, not tsc): no type annotations,
 * no `readonly`/`private` keywords — `contract =` and `#live` instead — and
 * any TS syntax fails the build as a `subscription-delivery-halted` event.
 */
const slowFacetSource = `
import { StreamProcessorFacet } from "iterate/sdk";
import { defineProcessorContract, StreamProcessor } from "iterate/processors";
import { z } from "zod";

export const SlowContract = defineProcessorContract({
  slug: "slow-work",
  version: "1.0.0",
  description: "A processor whose side effect is deliberately slow, to prove facet revival.",
  stateSchema: z.object({
    pending: z.array(z.string()).default([]),
    completed: z.array(z.string()).default([]),
  }),
  events: {
    "${WORK_REQUESTED}": {
      description: "Opens a slow-work obligation.",
      payloadSchema: z.object({ id: z.string() }),
    },
    "${WORK_STARTED}": {
      description: "Telemetry: a slow-work attempt began (before the slow body).",
      payloadSchema: z.object({ id: z.string() }),
    },
    "${WORK_COMPLETED}": {
      description: "The slow side effect finished; settles the obligation.",
      payloadSchema: z.object({ id: z.string() }),
    },
  },
  consumes: ["${WORK_REQUESTED}", "${WORK_COMPLETED}"],
  emits: ["${WORK_STARTED}", "${WORK_COMPLETED}"],
});

class SlowProcessor extends StreamProcessor {
  contract = SlowContract;
  // The incarnation's live-set: which ids this incarnation is already driving.
  // Empty after an eviction, which is exactly what makes the at-head pass
  // restart a lost attempt.
  #live = new Set();

  reduce({ state, event }) {
    if (event.type === "${WORK_REQUESTED}") {
      return { ...state, pending: [...state.pending, event.payload.id] };
    }
    if (event.type === "${WORK_COMPLETED}") {
      return {
        ...state,
        pending: state.pending.filter((id) => id !== event.payload.id),
        completed: [...state.completed, event.payload.id],
      };
    }
    return state;
  }

  processEvent({ state, delivery, append, runInBackground }) {
    // Obligation pattern: only START from the AT-HEAD reduced state, so a
    // replay/catch-up (where pending may not yet have absorbed its completion)
    // never re-fires the slow effect. This branch is BOTH the normal start and
    // the post-eviction restart (the revival's eventless caught-up pass).
    if (!delivery.caughtUp) return;
    for (const id of state.pending) {
      if (this.#live.has(id)) continue;
      this.#live.add(id);
      runInBackground(async () => {
        try {
          // Idempotency-keyed, deterministic bodies: a re-drive after revival
          // re-appends the same started/completed facts and the stream dedupes
          // them, so replay is safe.
          await append({ type: "${WORK_STARTED}", idempotencyKey: "started@" + id, payload: { id } });
          // The "somewhat slow" side effect. On eviction this closure is lost;
          // recovery re-runs it from the still-open \`requested\` evidence.
          await new Promise((resolve) => setTimeout(resolve, ${SLOW_WORK_MS}));
          await append({ type: "${WORK_COMPLETED}", idempotencyKey: "completed@" + id, payload: { id } });
        } finally {
          this.#live.delete(id);
        }
      });
    }
  }
}

// The whole userspace facet: pick recovery (this processor owes background
// work) and build the processor. Everything else — the itx alarm proxy, the
// stream handle, configure/handleAlarm — is the StreamProcessorFacet base.
export class SlowFacet extends StreamProcessorFacet {
  recovery = true;
  createProcessor(deps) {
    return new SlowProcessor(deps);
  }
}
`;

test(
  "a userspace facet processor's slow side effect survives killing the Stream DO: the parent alarm revives it and finishes the work",
  // Ceiling covering the two sequential waits below (cold build + revival) plus
  // setup. The expected run is ~60-90s — dominated by the one-time cold facet
  // build and the framework's ~10s keepalive lead, both irreducible; the
  // deliberate slow effect itself is only 8s.
  { timeout: 180_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects
      .get(`facet-revival-${crypto.randomUUID().slice(0, 8)}`)
      .create({});
    await project.projectId;

    const streamPath = "/slow";
    const subscriptionName = "slow-work";
    const workId = `work-${crypto.randomUUID().slice(0, 8)}`;

    // Author the processor as ordinary project code in the config repo.
    await project.repo.commitFiles({
      changes: [{ content: slowFacetSource, path: "slow-facet.js" }],
      message: "A userspace facet processor with a slow, recovery-backed side effect",
    });

    const stream = project.streams.get(streamPath);

    // Place the userspace class as a FACET of this stream's own Durable Object.
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
              className: "SlowFacet",
              durableWorkerKey: "slow-facet",
              source: {
                createWorker: {
                  entryPoint: "slow-facet.js",
                  files: { type: "repo", repoPath: "/repos/config" },
                },
              },
            },
          },
        },
      },
    } satisfies StreamEventInput);

    const eventTypesOnStream = async (type: string): Promise<string[]> => {
      const events = await stream.getEvents({ eventTypes: [type] });
      return events.map((event) => (event.payload as { id: string }).id);
    };

    // Open the obligation. This forces the cold facet build and wakes the
    // processor; a build failure would surface as a `subscription-delivery-halted`
    // event on the stream (read it if the wait below ever times out).
    await stream.append({
      type: WORK_REQUESTED,
      payload: { id: workId },
    } satisfies StreamEventInput);

    // The attempt is in flight once it appended `…/started` (which happens
    // before the slow body). Reaching this proves the userspace class LOADED
    // and ran as a facet.
    await waitForCondition(async () => (await eventTypesOnStream(WORK_STARTED)).includes(workId), {
      description: "the userspace facet to build, wake, and start its slow attempt",
      timeoutMs: 90_000,
    });

    // ...and it has NOT completed yet — the slow body is still running, and the
    // keepalive has armed the parent's real platform alarm through the itx
    // proxy. If this fails, SLOW_WORK_MS is too short for this environment.
    expect(await eventTypesOnStream(WORK_COMPLETED)).not.toContain(workId);

    // Kill the Stream DO mid-work. This aborts the parent incarnation and its
    // facet, dropping the in-flight background attempt. The durable alarm the
    // keepalive armed survives.
    await stream.kill().catch(() => undefined);

    // Revival: the platform fires the surviving alarm in a fresh incarnation,
    // which replays it into the reloaded facet's handleAlarm; recovery re-drives
    // the still-open obligation from the committed `requested` evidence, and the
    // slow effect runs to completion. The completion could ONLY have come from
    // the revival — the first attempt died with the incarnation.
    await waitForCondition(
      async () => (await eventTypesOnStream(WORK_COMPLETED)).includes(workId),
      {
        description: "the alarm to revive the killed facet and finish the slow work",
        timeoutMs: 60_000,
      },
    );

    // The processor's own committed fold reflects the settled obligation.
    const settled = await stream.subscriptions.get(subscriptionName).processor.snapshot();
    expect((settled.state as { completed: string[] }).completed).toContain(workId);
    expect((settled.state as { pending: string[] }).pending).not.toContain(workId);
  },
);
