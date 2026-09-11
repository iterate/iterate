// cold-alarm-idle.e2e.test.ts — a deployed/public regression for the idle-alarm fixed point.
// A configured `consumes: ["*"]` processor is deliberately enough to materialize a facet: after
// every client session is gone, that facet must quiesce. A cold alarm must not materialize it, append
// another durable `stream/woken` fact, and thereby arm the next one-minute alarm indefinitely.
//
// The only seam is the ordinary authenticated ITX WebSocket API. `stream/woken` is a durable public
// lifecycle fact, so it lets the test distinguish a platform's normal one final cold read wake from
// application-created recurring wake/alarm work without inspecting alarms, storage, or DO internals.

import { expect, test } from "vitest";
import {
  append,
  disposeSessions,
  freshCtx,
  openItx,
  readAll,
  sleep,
  subscriptions,
} from "./support/client.ts";
import { enableFixtureProcessor } from "./support/sources.ts";

const WOKEN = "events.iterate.com/stream/woken";
const local = /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(process.env.WORKER_BASE_URL ?? "");

const idleDigestSource = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class IdleDigest extends WorkerEntrypoint {
  async processEventBatch(events) {
    const sink = (await this.env.ITX.get()).cd("/sink");
    const n = Number((await sink.kv.get("digested")) ?? 0) + events.length;
    await sink.kv.put("digested", String(n));
    return n;
  }
}`,
};

const wokenCount = (events: any[]): number => events.filter((event) => event.type === WOKEN).length;

async function deliveredCount(sink: any, after: number): Promise<number> {
  for (let attempts = 0; attempts < 50; attempts++) {
    const count = Number((await sink.kv.get("digested")) ?? 0);
    if (count > after) return count;
    await sleep(100);
  }
  throw new Error(`stateless cursor did not deliver after ${after} within 5s`);
}

test.skipIf(local)(
  "an idle processor context quiesces: internal alarms do not append stream/woken once per minute",
  { timeout: 180_000 },
  async () => {
    const context = freshCtx("cold-alarm-idle");
    const itx = openItx(context);
    await enableFixtureProcessor(itx, "user-tally");
    const [marker] = await append(itx, { type: "idle-marker" });
    const initialSnapshot: any = await itx.invoke("itx.facets.get('user-tally').snapshot()");
    expect(initialSnapshot.offset).toBeGreaterThanOrEqual(marker.offset);
    expect(initialSnapshot.state.counts["idle-marker"]).toBe(1);
    const beforeIdle = await readAll(itx);
    const wakesBeforeIdle = wokenCount(beforeIdle);
    console.info(
      JSON.stringify({
        event: "cold-alarm-idle-start",
        context,
        wakesBeforeIdle,
        utc: new Date().toISOString(),
      }),
    );

    // No live caller may keep the context warm. The suite's afterEach would also do this, but doing
    // it here makes the two-minute idle interval part of the public test's stated precondition.
    disposeSessions();
    await sleep(125_000);

    // One quiet-clock alarm and this final public read can each legitimately cold-start the DO and
    // add a wake record. Further one-per-minute growth is an application alarm cycle.
    const afterIdle = await readAll(openItx(context));
    const wakesAfterIdle = wokenCount(afterIdle);
    console.info(
      JSON.stringify({
        event: "cold-alarm-idle-observed",
        context,
        wakesBeforeIdle,
        wakesAfterIdle,
        utc: new Date().toISOString(),
      }),
    );
    expect(wakesAfterIdle).toBeLessThanOrEqual(wakesBeforeIdle + 2);

    // Quiescing is runtime-only: the public processor contract and its durable reduction survive.
    const snapshot: any = await openItx(context).invoke("itx.facets.get('user-tally').snapshot()");
    expect(snapshot.state.counts["idle-marker"]).toBe(1);
  },
);

test.skipIf(local)(
  "an idle stateless cursor defers its wake delivery until a public door, without an alarm wake cycle",
  { timeout: 180_000 },
  async () => {
    const context = freshCtx("cold-alarm-cursor-idle");
    const itx = openItx(context);
    const sink = openItx(context).cd("/sink");
    // These are the same raw durable facts that the public verbs append. Unlike `provide()` and
    // `subscribe()`, they intentionally have no session lease: disposal is the precondition here.
    await append(
      itx,
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: {
          match: "itx.idleDigest",
          target: `itx.workers.get({ source: ${JSON.stringify(idleDigestSource)} })`,
        },
      },
      {
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          name: "idle-digest",
          target: "itx.idleDigest.processEventBatch",
          consumes: ["*"],
        },
      },
      { type: "idle-cursor-marker" },
    );
    const deliveriesBeforeIdle = await deliveredCount(sink, 0);
    const wakesBeforeIdle = wokenCount(await readAll(itx));
    console.info(
      JSON.stringify({
        event: "cold-alarm-cursor-idle-start",
        context,
        wakesBeforeIdle,
        deliveriesBeforeIdle,
        utc: new Date().toISOString(),
      }),
    );

    disposeSessions();
    await sleep(125_000);

    // An alarm and this read can each cold-start once. The read is also the external door that
    // must release the deferred durable wake to the cursor; it must not be dropped or pre-consumed.
    const afterIdle = await readAll(openItx(context));
    const wakesAfterIdle = wokenCount(afterIdle);
    expect((await subscriptions(openItx(context))).map((row) => row.name)).toContain("idle-digest");
    console.info(
      JSON.stringify({
        event: "cold-alarm-cursor-idle-wakes",
        context,
        wakesBeforeIdle,
        wakesAfterIdle,
        deliveriesBeforeIdle,
        utc: new Date().toISOString(),
      }),
    );
    expect(wakesAfterIdle).toBeLessThanOrEqual(wakesBeforeIdle + 2);
    const deliveriesAfterIdle = await deliveredCount(
      openItx(context).cd("/sink"),
      deliveriesBeforeIdle,
    );
    console.info(
      JSON.stringify({
        event: "cold-alarm-cursor-idle-observed",
        context,
        wakesBeforeIdle,
        wakesAfterIdle,
        deliveriesBeforeIdle,
        deliveriesAfterIdle,
        utc: new Date().toISOString(),
      }),
    );
  },
);
