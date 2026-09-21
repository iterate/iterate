// e2e/scheduled-appends-dormant.e2e.test.ts — the one row that must outwait the pins' real release deadline
// (75 s), in a file of its own so the wait runs beside the suite instead of adding to it.
import { expect, test } from "vitest";
import { disposeSessions, freshCtx, openItx, readAll, sleep } from "./support/client.ts";
import { scheduledAppendFacetSource } from "./support/scheduled-append-facet.ts";

// Crosses the real pins' release deadline without a client or waitForEvent keeping it
// active; 100 seconds bounds the 75-second deadline plus reconnect and assertions.
test("a disconnected userspace facet's deadline fires after the pins' release without another request", async () => {
  const ctx = freshCtx("schedule_dormant");
  const itx = openItx(ctx);
  await itx.processors.enable("deadlines", {
    source: scheduledAppendFacetSource,
    className: "DeadlinesDurableObject",
  });
  const at = new Date(Date.now() + 75_000).toISOString();
  await itx.facets.get("deadlines").start("dormant", { at });
  disposeSessions();
  await sleep(77_000);
  const reconnectedAt = Date.now();
  const reconnected = openItx(ctx);
  const events = await readAll(reconnected);
  const due = events.filter((event) => event.type === "job/timed-out");
  expect(due).toHaveLength(1);
  expect(Date.parse(due[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(at));
  expect(Date.parse(due[0].createdAt)).toBeLessThan(reconnectedAt);
  expect(await reconnected.schedules.list()).toEqual([]);
  await reconnected.facets.get("deadlines").waitUntilProcessed({ offset: due[0].offset });
  expect((await reconnected.facets.get("deadlines").snapshot()).state.timedOut).toEqual([
    "dormant",
  ]);
}, 100_000);

test("facet-scoped relative deadlines and serializable receipts keep two instances independent", async () => {
  const itx = openItx(freshCtx("schedule_scoped"));
  for (const name of ["first", "second"]) {
    await itx.processors.enable(name, {
      source: scheduledAppendFacetSource,
      className: "DeadlinesDurableObject",
    });
  }
  const first = await itx.facets.get("first").start("same-job", { afterMs: 1500 });
  const second = await itx.facets.get("second").start("same-job", { afterMs: 60_000 });
  expect(first.key).not.toBe(second.key);
  const row = await itx.schedules.get(["first", "same-job"]);
  const definition = (await readAll(itx)).find(
    (event) => event.offset === first.scheduledAtOffset,
  )!;
  expect(Date.parse(row.nextAt) - Date.parse(definition.createdAt)).toBe(1500);
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
