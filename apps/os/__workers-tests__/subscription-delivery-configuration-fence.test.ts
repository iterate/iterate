// The private subscriptions facet receives asynchronous platform pushes. These rows construct the
// existing first-party facet through the context's own `state.exports`/`state.facets` identity: an
// author cannot reach that route. They make a delayed older push deterministic, including after
// the facet is restarted or deleted.

import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { releasePins, stub, until } from "./support.ts";

type Configuration = { rows: unknown[]; throughOffset: number };

const FLAKY_TARGET = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class Flaky extends WorkerEntrypoint {
  async processEventBatch() { throw new Error("retry later"); }
}
`,
};

const COUNT_EPHEMERALS = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class CountEphemerals extends WorkerEntrypoint {
  async processEventBatch(events) {
    using itx = this.getItx();
    const count = Number((await itx.kv.get("fence-ephemeral-count")) ?? "0");
    await itx.kv.put("fence-ephemeral-count", String(count + events.length));
  }
}
`,
};

test("a stale configuration push after replacement and facet restart retains the replacement cursor and retry claim", async () => {
  const context = "prj_subscription_delivery_configuration_fence_replacement";
  const s = stub(context);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "swap",
      target: "itx.whoami",
      delivery: "durable",
      consumes: ["test/fence-a"],
    },
  });
  const staleA = await configuration(context);

  const [replacement, event] = (await s.append(
    {
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "swap",
        target: ["itx", "workers", ["get", { source: FLAKY_TARGET }], "processEventBatch"],
        delivery: "durable",
        consumes: ["test/fence-b"],
      },
    },
    { type: "test/fence-b", payload: { b: true } },
  )) as { offset: number }[];

  const before = await until("replacement records its future retry", async () => {
    const status = await deliveryStatus(context);
    const cursor = status.snapshots[`swap@${replacement.offset}`];
    return cursor?.pending?.attempt === 1 && (cursor.pending.nextAttemptAtMs ?? 0) > Date.now()
      ? { status, cursor }
      : undefined;
  });
  expect(before.cursor.confirmedOffset).toBeLessThan(event.offset);
  const claimBefore = await alarm(context);
  expect(claimBefore).not.toBeNull();

  // The stale platform call is deliberately delivered only after a fresh facet incarnation starts.
  // It must neither restore A nor clear B's retry claim.
  await pushPrivateFacet(
    context,
    [],
    { after: staleA.throughOffset, through: staleA.throughOffset },
    staleA,
    {
      restart: true,
    },
  );

  const after = await deliveryStatus(context);
  expect(after.snapshots[`swap@${replacement.offset}`]).toEqual(before.cursor);
  expect(after.snapshots[`swap@${staleA.throughOffset}`]).toBeUndefined();
  expect(await alarm(context)).toBe(claimBefore);
  await releasePins(context);
});

test("equal durable configuration snapshots carry distinct ephemeral-only commits", async () => {
  const context = "prj_subscription_delivery_configuration_fence_equal";
  const s = stub(context);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "ephemeral",
      target: ["itx", "workers", ["get", { source: COUNT_EPHEMERALS }], "processEventBatch"],
      delivery: "durable",
      consumes: ["test/fence-ephemeral"],
    },
  });
  const configured = await configuration(context);

  await s.append({ type: "test/fence-ephemeral", payload: { first: true }, ephemeral: true });
  await until(
    "the first ordinary ephemeral push arrives",
    async () => (await s.invoke(["itx", "kv", ["get", "fence-ephemeral-count"]])) === "1",
  );
  // Ephemerals advance neither the durable log nor the configuration fence. The second ordinary
  // commit therefore reaches `processEventBatch` with the same accepted through offset.
  expect(await configuration(context)).toEqual(configured);

  await s.append({ type: "test/fence-ephemeral", payload: { second: true }, ephemeral: true });
  await until(
    "the second equal-snapshot ephemeral push arrives",
    async () => (await s.invoke(["itx", "kv", ["get", "fence-ephemeral-count"]])) === "2",
  );
  expect(await configuration(context)).toEqual(configured);
  await releasePins(context);
});

test("the first cold-facet push after deletion rejects an older snapshot using current core configuration", async () => {
  const context = "prj_subscription_delivery_configuration_fence_deleted";
  const s = stub(context);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "removed",
      target: "itx.whoami",
      delivery: "durable",
      consumes: ["test/fence-removed"],
    },
  });
  const staleA = await configuration(context);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "removed", target: null },
  });

  // This is the first call to a freshly materialized private facet after the removal. Its supplied
  // A snapshot must lose to the context's newer empty configuration and cannot recreate a cursor.
  await pushPrivateFacet(
    context,
    [],
    { after: staleA.throughOffset, through: staleA.throughOffset },
    staleA,
  );
  expect(await privateSnapshots(context)).toEqual({});
  await releasePins(context);
});

async function configuration(context: string): Promise<Configuration> {
  return (await runInDurableObject(stub(context), (instance) =>
    instance.subscriptionDeliveryConfiguration(),
  )) as Configuration;
}

/** Platform-only test harness for the same named first-party facet that FacetHost uses. */
async function pushPrivateFacet(
  context: string,
  events: StreamEvent[],
  range: { after: number; through: number },
  config: Configuration,
  { restart = false }: { restart?: boolean } = {},
): Promise<void> {
  await runInDurableObject(stub(context), async (_instance, state) => {
    if (restart) state.facets.abort("subscriptions", "configuration-fence test restart");
    const entry = (
      state as unknown as {
        exports: {
          SubscriptionDeliveryDurableObject(options: {
            props: { iterateContextName: string; name: string };
          }): unknown;
        };
      }
    ).exports.SubscriptionDeliveryDurableObject;
    const klass = entry({
      props: { iterateContextName: state.id.name!, name: "subscriptions" },
    });
    const facet = state.facets.get("subscriptions", () => ({
      class: klass as never,
    })) as unknown as {
      processEventBatch(
        events: StreamEvent[],
        range: { after: number; through: number },
        rows: unknown[],
        throughOffset: number,
      ): Promise<void>;
    };
    await facet.processEventBatch(events, range, config.rows, config.throughOffset);
  });
}

/** Reads the facet itself: context status intentionally returns an empty shortcut with no core rows. */
async function privateSnapshots(context: string): Promise<Record<string, unknown>> {
  return await runInDurableObject(stub(context), async (_instance, state) => {
    const entry = (
      state as unknown as {
        exports: {
          SubscriptionDeliveryDurableObject(options: {
            props: { iterateContextName: string; name: string };
          }): unknown;
        };
      }
    ).exports.SubscriptionDeliveryDurableObject;
    const klass = entry({
      props: { iterateContextName: state.id.name!, name: "subscriptions" },
    });
    const facet = state.facets.get("subscriptions", () => ({
      class: klass as never,
    })) as unknown as {
      deliverySnapshots(): Promise<Record<string, unknown>>;
    };
    return await facet.deliverySnapshots();
  });
}

const deliveryStatus = async (context: string) =>
  (await runInDurableObject(stub(context), (instance) =>
    instance.subscriptionDeliveryStatus(),
  )) as {
    snapshots: Record<
      string,
      { confirmedOffset: number; pending?: { attempt: number; nextAttemptAtMs?: number } }
    >;
  };

const alarm = (context: string) =>
  runInDurableObject(stub(context), (_instance, state) => state.storage.getAlarm());
