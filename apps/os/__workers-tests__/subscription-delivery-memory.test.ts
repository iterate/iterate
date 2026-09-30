// A private durable delivery read must be shared across rows: twenty rows may inspect one
// near-limit page, but they cannot materialize twenty copies before handing their tiny matches to
// a target. This is the replacement for the removed cursor-row memory-budget scenario.

import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { HOLD } from "./sources.ts";
import { releasePins, stub, until } from "./support.ts";

const MiB = 1024 * 1024;

test("twenty durable rows share one source-page reservation, then drain after their held target releases", async () => {
  const context = "prj_subscription_delivery_memory";
  const s = stub(context);
  const target = ["itx", "facets", ["get", "hold", HOLD], "processEventBatch"];
  const configured = await s.append(
    ...Array.from({ length: 20 }, (_, i) => ({
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "row-" + i,
        target,
        delivery: "durable",
        consumes: ["work-" + i],
      },
    })),
  );
  const work = await s.append(
    { type: "noise", payload: { blob: "x".repeat(7 * MiB) } },
    ...Array.from({ length: 20 }, (_, i) => ({ type: "work-" + i, payload: { i } })),
  );
  const workOffsets = new Set(
    (work as { type: string; offset: number }[])
      .filter((event) => event.type.startsWith("work-"))
      .map((event) => event.offset),
  );

  await until("the held target has accepted the first durable delivery", async () =>
    Boolean(await s.invoke(["itx", "facets", ["get", "hold", HOLD], ["holding"]])),
  );
  const status = (await runInDurableObject(s, (instance) =>
    instance.subscriptionDeliveryStatus(),
  )) as {
    readReservedBytes: number;
    readWaiters: number;
    pendingEphemeralChars: number;
    targetBodyChars: number;
    snapshots: Record<string, { pending?: unknown }>;
  };
  expect(status).toMatchObject({
    readReservedBytes: 0,
    readWaiters: 0,
    pendingEphemeralChars: 0,
  });
  expect(status.targetBodyChars).toBeLessThanOrEqual(8 * MiB);
  expect(Object.values(status.snapshots).filter((snapshot) => snapshot.pending)).not.toHaveLength(
    0,
  );

  for (let i = 0; i < 20; i++) {
    await s.invoke(["itx", "facets", ["get", "hold", HOLD], ["release"]]);
    if (i < 19)
      await until("held target starts next delivery", async () =>
        Boolean(await s.invoke(["itx", "facets", ["get", "hold", HOLD], ["holding"]])),
      );
  }
  await until("all durable rows acknowledge their tiny matched event", async () => {
    const current = (await runInDurableObject(s, (instance) =>
      instance.subscriptionDeliveryStatus(),
    )) as {
      readReservedBytes: number;
      readWaiters: number;
      pendingEphemeralChars: number;
      targetBodyChars: number;
      snapshots: Record<string, { confirmedOffset?: number; pending?: unknown }>;
    };
    const confirmed = Object.values(current.snapshots)
      .map((snapshot) => snapshot.confirmedOffset)
      .filter((offset): offset is number => offset !== undefined);
    return (
      confirmed.length === 20 &&
      [...workOffsets].every((offset) => confirmed.includes(offset)) &&
      current.readReservedBytes === 0 &&
      current.readWaiters === 0 &&
      current.pendingEphemeralChars === 0 &&
      current.targetBodyChars === 0
    );
  });
  expect(configured).toHaveLength(20);
  await releasePins(context);
});
