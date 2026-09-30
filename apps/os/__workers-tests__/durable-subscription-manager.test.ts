import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { HOLD, flakyCounter } from "./sources.ts";
import { releasePins, rowOf, stub, until } from "./support.ts";

const FLAKY_SOURCE = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Flaky extends WorkerEntrypoint {
  async processEventBatch(events) {
    using itx = this.getItx();
    if ((await itx.kv.get("mode")) === "fail") throw new Error("target refused");
    const count = Number((await itx.kv.get("durable-count")) ?? 0) + 1;
    await itx.kv.put("durable-count", String(count));
  }
}`,
};

test("a future retry survives eviction, alarms a cold context, and delivers once", async () => {
  const context = "prj_manager_cold_retry";
  const s = stub(context);
  await s.invoke(["itx", "kv", ["put", "mode", "fail"]]);
  await configure(context, "retry", workerTarget(FLAKY_SOURCE), ["work"]);
  const [event] = (await s.append({ type: "work" })) as { offset: number }[];
  await until("first target failure is persisted", async () => {
    const status = await runInDurableObject(s, (instance) => instance.subscriptionDeliveryStatus());
    const pending = Object.values(status.snapshots)[0]?.pending;
    return pending?.attempt === 1 &&
      pending.nextAttemptAtMs !== undefined &&
      pending.nextAttemptAtMs <= Date.now() + 1_000
      ? status
      : undefined;
  });
  await releasePins(context);
  await evictDurableObject(s);
  await s.invoke(["itx", "kv", ["put", "mode", "ok"]]);
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 30_000);
    await runDurableObjectAlarm(s);
  } finally {
    vi.useRealTimers();
  }
  const delivered = await until("cold retry confirms once", async () => {
    const row = await rowOf(context, "retry");
    return row?.cursor?.confirmedOffset !== undefined && row.cursor.confirmedOffset >= event.offset
      ? row
      : undefined;
  });
  expect(delivered.cursor?.nextAttemptAtMs).toBeUndefined();
  expect(await s.invoke(["itx", "kv", ["get", "durable-count"]])).toBe("1");
  await releasePins(context);
  await evictDurableObject(s);
});

test("a permanent refusal remains halted across eviction and a resume admits later work", async () => {
  const context = "prj_manager_halt_resume";
  const s = stub(context);
  const target = [
    "itx",
    "facets",
    ["get", "refusal", flakyCounter("refused", { code: "PERMANENT_FAILURE" })],
    "processEventBatch",
  ];
  await configure(context, "halt", target, ["work"]);
  const [first] = (await s.append({ type: "work" })) as { offset: number }[];
  await until("row halts", async () => (await rowOf(context, "halt"))?.halted);
  await releasePins(context);
  await evictDurableObject(s);
  expect((await rowOf(context, "halt"))?.halted).toMatchObject({
    afterOffset: expect.any(Number),
    attempts: 1,
  });
  await s.append({
    type: "events.iterate.com/itx/subscription-delivery-resumed",
    payload: { name: "halt", afterOffset: first.offset },
  });
  const [later] = (await s.append({ type: "work" })) as { offset: number }[];
  await until("resume confirms later work", async () => {
    const row = await rowOf(context, "halt");
    return row?.cursor?.confirmedOffset !== undefined &&
      row.cursor.confirmedOffset >= later.offset &&
      !row.halted
      ? row
      : undefined;
  });
  await releasePins(context);
});

test("a removed held row cannot recreate a cursor or halt when its old target returns", async () => {
  const context = "prj_manager_removed_held";
  const s = stub(context);
  const target = ["itx", "facets", ["get", "held", HOLD], "processEventBatch"];
  await configure(context, "removed", target, ["test/held"]);
  await s.append({ type: "test/held" });
  await until("target holds the old call", async () =>
    Boolean(await s.invoke(["itx", "facets", ["get", "held", HOLD], ["holding"]])),
  );
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "removed", target: null },
  });
  await s.invoke(["itx", "facets", ["get", "held", HOLD], ["release"]]);
  await until("old target settles without restoring removed state", async () => {
    const state = await runInDurableObject(s, async (instance, doState) => ({
      status: await instance.subscriptionDeliveryStatus(),
      cursorKeys: [...doState.storage.kv.list({ prefix: "durable-delivery/" })].map(([key]) => key),
      deliveryWake: doState.storage.kv.get("durable-delivery-wake-at"),
    }));
    return state.status.activeTargetDeliveries === 0 &&
      !Object.keys(state.status.snapshots).some((key) => key.startsWith("removed@")) &&
      !state.cursorKeys.some((key) => key.startsWith("durable-delivery/removed@")) &&
      state.deliveryWake === undefined &&
      (await rowOf(context, "removed")) === null
      ? state
      : undefined;
  });
  await releasePins(context);
});

const workerTarget = (source: Record<string, string>) => [
  "itx",
  "workers",
  ["get", { source }],
  "processEventBatch",
];

async function configure(
  context: string,
  name: string,
  target: unknown[],
  consumes: string[],
  ordered?: false,
) {
  await stub(context).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name, target, delivery: "durable", consumes, ...(ordered === false && { ordered }) },
  });
}
