// A context-owned durable delivery read must be shared across rows: twenty rows may inspect one
// near-limit page, but they cannot materialize twenty copies before handing their tiny matches to
// a target. This is the replacement for the removed cursor-row memory-budget scenario.

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { FANOUT_HOLD, HOLD } from "./sources.ts";
import { releasePins, stub, until } from "./support.ts";

const MiB = 1024 * 1024;
type Status = {
  targetBodyChars: number;
  activeTargetDeliveries: number;
  snapshots: Record<
    string,
    {
      confirmedOffset?: number;
      pending?: { attempt?: number };
      fanOut?: unknown[];
    }
  >;
};

test("a held 7MiB selected target leaves twenty disjoint tiny rows free to settle", async () => {
  const context = "prj_subscription_delivery_body_local";
  const s = stub(context);
  const slowTarget = ["itx", "facets", ["get", "slow-hold", HOLD], "processEventBatch"];
  await s.append(
    {
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "slow",
        target: slowTarget,
        delivery: "durable",
        consumes: ["test/held-large"],
      },
    },
    ...Array.from({ length: 20 }, (_, i) => ({
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: `tiny-${i}`,
        target: "itx.whoami",
        delivery: "durable",
        consumes: [`test/tiny-${i}`],
      },
    })),
  );
  const appended = (await s.append(
    { type: "test/held-large", payload: { blob: "x".repeat(7 * MiB) } },
    ...Array.from({ length: 20 }, (_, i) => ({ type: `test/tiny-${i}`, payload: { i } })),
  )) as { type: string; offset: number }[];
  const tinyThrough = appended.at(-1)!.offset;
  await until("the selected 7MiB target is held", async () =>
    Boolean(await s.invoke(["itx", "facets", ["get", "slow-hold", HOLD], ["holding"]])),
  );
  await until("twenty disjoint tiny rows settle beside the held body", async () => {
    const status = (await runInDurableObject(s, (instance) =>
      instance.subscriptionDeliveryStatus(),
    )) as Status;
    return Object.entries(status.snapshots)
      .filter(([key]) => key.startsWith("tiny-"))
      .every(([, row]) => row.confirmedOffset !== undefined && row.confirmedOffset >= tinyThrough);
  });
  const during = (await runInDurableObject(s, (instance) =>
    instance.subscriptionDeliveryStatus(),
  )) as Status;
  // Tiny rows already confirmed while the independent large target remains held. They need not
  // remain in flight: fairness is their progress beside the hold, not artificial overlap.
  expect(await s.invoke(["itx", "facets", ["get", "slow-hold", HOLD], ["holding"]])).toBe(true);
  expect(during).toMatchObject({ activeTargetDeliveries: 1 });
  expect(during.targetBodyChars).toBeLessThanOrEqual(8 * MiB);
  await s.invoke(["itx", "facets", ["get", "slow-hold", HOLD], ["release"]]);
  await until("the held 7MiB body settles", async () => {
    const status = (await runInDurableObject(s, (instance) =>
      instance.subscriptionDeliveryStatus(),
    )) as Status;
    return status.targetBodyChars === 0 && status.activeTargetDeliveries === 0;
  });
  await releasePins(context);
});

test("a second 5MiB target waits busy without consuming an attempt, then advances after release", async () => {
  const context = "prj_subscription_delivery_body_busy";
  const s = stub(context);
  const target = (name: string) => ["itx", "facets", ["get", name, HOLD], "processEventBatch"];
  await s.append(
    {
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "a",
        target: target("hold-a"),
        delivery: "durable",
        consumes: ["test/held-a"],
      },
    },
    {
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "b",
        target: target("hold-b"),
        delivery: "durable",
        consumes: ["test/held-b"],
      },
    },
  );
  await s.append({ type: "test/held-a", payload: { blob: "a".repeat(5 * MiB) } });
  await until("the first 5MiB target holds", async () =>
    Boolean(await s.invoke(["itx", "facets", ["get", "hold-a", HOLD], ["holding"]])),
  );
  await s.append({ type: "test/held-b", payload: { blob: "b".repeat(5 * MiB) } });
  await until("the second body is busy without an attempt", async () => {
    const status = (await runInDurableObject(s, (instance) =>
      instance.subscriptionDeliveryStatus(),
    )) as Status;
    const second = Object.entries(status.snapshots).find(([key]) => key.startsWith("b@"))?.[1];
    return status.activeTargetDeliveries === 1 && second?.pending?.attempt === 0;
  });
  await s.invoke(["itx", "facets", ["get", "hold-a", HOLD], ["release"]]);
  await until("the second 5MiB target starts after the first release", async () =>
    Boolean(await s.invoke(["itx", "facets", ["get", "hold-b", HOLD], ["holding"]])),
  );
  await s.invoke(["itx", "facets", ["get", "hold-b", HOLD], ["release"]]);
  await until("both 5MiB calls settle", async () => {
    const status = (await runInDurableObject(s, (instance) =>
      instance.subscriptionDeliveryStatus(),
    )) as Status;
    return status.activeTargetDeliveries === 0 && status.targetBodyChars === 0;
  });
  await releasePins(context);
});

test("a fan-out target has exactly eight overlapping calls", async () => {
  const context = "prj_subscription_delivery_fanout_eight";
  const s = stub(context);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "fanout",
      target: ["itx", "facets", ["get", "fanout-hold", FANOUT_HOLD], "deliverEvent"],
      delivery: "durable",
      ordered: false,
      consumes: ["test/fanout"],
    },
  });
  const events = (await s.append(
    ...Array.from({ length: 16 }, (_, i) => ({ type: "test/fanout", payload: { i } })),
  )) as { offset: number }[];
  const target = (step: unknown[]) =>
    s.invoke(["itx", "facets", ["get", "fanout-hold", FANOUT_HOLD], step]);
  await until(
    "the first fan-out admission fills eight calls",
    async () => (await target(["holding"])) === 8,
  );
  const during = (await runInDurableObject(s, (instance) =>
    instance.subscriptionDeliveryStatus(),
  )) as Status;
  expect(during).toMatchObject({ activeTargetDeliveries: 8 });
  for (let wave = 0; wave < 2; wave++) {
    await until(
      "a fan-out wave is actually holding eight calls",
      async () => (await target(["holding"])) === 8,
    );
    for (let i = 0; i < 8; i++) await target(["release"]);
  }
  await until("all fan-out calls settle", async () => {
    const status = (await runInDurableObject(s, (instance) =>
      instance.subscriptionDeliveryStatus(),
    )) as Status;
    const cursor = Object.entries(status.snapshots).find(([key]) => key.startsWith("fanout@"))?.[1];
    return (
      status.activeTargetDeliveries === 0 &&
      (cursor?.confirmedOffset ?? -1) >= events.at(-1)!.offset &&
      (cursor?.fanOut?.length ?? 0) === 0
    );
  });
  await releasePins(context);
});

test("a near-8MiB legal event is admitted alone to an otherwise idle durable target", async () => {
  const context = "prj_subscription_delivery_single_large";
  const s = stub(context);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "large",
      target: ["itx", "facets", ["get", "hold", HOLD], "processEventBatch"],
      delivery: "durable",
      consumes: ["test/held"],
    },
  });
  const bodyOverhead = JSON.stringify({
    type: "test/held",
    payload: { blob: "" },
    createdAt: "2026-09-30T00:00:00.000Z",
  }).length;
  const [event] = (await s.append({
    type: "test/held",
    // `s.append()` contributes a small RPC envelope beyond Stream's persisted body. Keep the
    // persisted body at the legal ceiling with room for that stable transport framing.
    payload: { blob: "x".repeat(8 * MiB - bodyOverhead - 256) },
  })) as { offset: number }[];

  await until("the one large event reaches the held target", async () =>
    Boolean(await s.invoke(["itx", "facets", ["get", "hold", HOLD], ["holding"]])),
  );
  const during = (await runInDurableObject(s, (instance) =>
    instance.subscriptionDeliveryStatus(),
  )) as { targetBodyChars: number };
  expect(during.targetBodyChars).toBeGreaterThan(8 * MiB - 512);

  await s.invoke(["itx", "facets", ["get", "hold", HOLD], ["release"]]);
  await until("the one large event is confirmed", async () => {
    const status = (await runInDurableObject(s, (instance) =>
      instance.subscriptionDeliveryStatus(),
    )) as { snapshots: Record<string, { confirmedOffset?: number }>; targetBodyChars: number };
    const cursor = Object.entries(status.snapshots).find(([key]) => key.startsWith("large@"))?.[1];
    const confirmedOffset = cursor?.confirmedOffset;
    return (
      confirmedOffset !== undefined &&
      confirmedOffset >= event.offset &&
      status.targetBodyChars === 0
    );
  });
  await releasePins(context);
});

test("a persisted admission wake drives a configured row with no cursor after a cold start", async () => {
  const context = "prj_subscription_delivery_persisted_admission_wake";
  const s = stub(context);
  const source = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async processEventBatch() {
    using itx = this.getItx();
    await itx.kv.put("persisted-admission-wake", "delivered");
  }
}
`,
  };
  let configuredAtOffset!: number;
  await runInDurableObject(s, async (instance, state) => {
    const [configured] = (await instance.append({
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "cold-admission",
        target: ["itx", "workers", ["get", { source }], "processEventBatch"],
        delivery: "durable",
        consumes: ["test/persisted-admission"],
      },
    })) as { offset: number }[];
    configuredAtOffset = configured.offset;
    await instance.append({ type: "test/persisted-admission" });
    // Model the narrow crash after commit and before the runner writes its admitted cursor.
    state.storage.kv.delete(`durable-delivery/cold-admission@${configuredAtOffset}`);
    state.storage.kv.put("durable-delivery-wake-at", Date.now());
  });
  await evictDurableObject(s);
  await runInDurableObject(s, async (instance) => {
    await instance.alarm();
  });
  await until(
    "the cold admission wake drives the durable target",
    async () =>
      (await s.invoke(["itx", "kv", ["get", "persisted-admission-wake"]])) === "delivered",
  );
  await releasePins(context);
});
