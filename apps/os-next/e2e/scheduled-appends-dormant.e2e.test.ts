// e2e/scheduled-appends-dormant.e2e.test.ts — the one row that must outwait the pins' real release
// (PIN_RELEASE_AFTER_IDLE_MS, 30 s — src/iterate-context-durable-object.ts) and the eviction that
// follows, in a file of its own so the wait runs beside the suite instead of adding to it.
import { expect, test } from "vitest";
import { disposeSessions, freshCtx, openItx, readAll, sleep } from "./support/client.ts";
import { scheduledAppendFacetSource } from "./support/scheduled-append-facet.ts";

// Crosses the real pins' release without a client or waitForEvent keeping it active: a 40 s deadline
// (the pins release at 30 s idle; the real scheduler evicted the idle DO inside 20 s, 2026-09-21), a
// 42 s sleep; 70 seconds bound the deadline plus reconnect and assertions.
test("a disconnected userspace facet's deadline fires after the pins' release without another request", async () => {
  const ctx = freshCtx("schedule_dormant");
  const itx = openItx(ctx);
  await itx.processors.enable("deadlines", {
    source: scheduledAppendFacetSource,
    className: "DeadlinesDurableObject",
  });
  const at = new Date(Date.now() + 40_000).toISOString();
  await itx.facets.get("deadlines").start("dormant", { at });
  disposeSessions();
  await sleep(42_000);
  const reconnectedAt = Date.now();
  const reconnected = openItx(ctx);
  const events = await readAll(reconnected);
  const due = events.filter((event) => event.type === "job/timed-out");
  expect(due).toHaveLength(1);
  expect(Date.parse(due[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(at));
  expect(Date.parse(due[0].createdAt)).toBeLessThan(reconnectedAt);
  // THE DIRECT PROOF OF DORMANCY: before the deadline's event the DO woke exactly twice — born by our
  // request, then by its alarm as a new incarnation (never by a request of ours: the sessions were
  // disposed). The reconnect's own wake comes after `due` and is not counted.
  const wakesBeforeDue = events
    .filter(
      (event) => event.type === "events.iterate.com/stream/woken" && event.offset < due[0].offset,
    )
    .map((event) => event.payload.reason);
  expect(wakesBeforeDue).toEqual(["request", "alarm"]);
  expect(await reconnected.schedules.list()).toEqual([]);
  await reconnected.facets.get("deadlines").waitUntilProcessed({ offset: due[0].offset });
  expect((await reconnected.facets.get("deadlines").snapshot()).state.timedOut).toEqual([
    "dormant",
  ]);
}, 70_000);

test("facet-scoped relative deadlines and serializable receipts keep two instances independent", async () => {
  const itx = openItx(freshCtx("schedule_scoped"));
  for (const name of ["first", "second"]) {
    await itx.processors.enable(name, {
      source: scheduledAppendFacetSource,
      className: "DeadlinesDurableObject",
    });
  }
  // 5 s: the three round trips below must read the row back before it fires (1.5 s flaked, 2026-09-21)
  const first = await itx.facets.get("first").start("same-job", { afterMs: 5_000 });
  const second = await itx.facets.get("second").start("same-job", { afterMs: 60_000 });
  expect(first.key).not.toBe(second.key);
  const row = await itx.schedules.get(["first", "same-job"]);
  const definition = (await readAll(itx)).find(
    (event) => event.offset === first.scheduledAtOffset,
  )!;
  expect(Date.parse(row.nextAt) - Date.parse(definition.createdAt)).toBe(5_000);
  await itx.facets.get("second").finish(JSON.parse(JSON.stringify(second)));
  expect(await itx.schedules.get(["second", "same-job"])).toBeNull();
  const due = await itx.waitForEvent({
    type: "job/timeout-audit",
    afterOffset: first.scheduledAtOffset,
  });
  await itx.facets.get("first").waitUntilProcessed({ offset: due.offset });
  await itx.facets.get("second").waitUntilProcessed({ offset: due.offset });
  expect((await itx.facets.get("first").snapshot()).state.timedOut).toEqual(["same-job"]);
  expect((await itx.facets.get("second").snapshot()).state.timedOut).toEqual([]);
});
