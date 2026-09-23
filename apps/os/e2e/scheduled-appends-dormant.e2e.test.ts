// e2e/scheduled-appends-dormant.e2e.test.ts — the one row that must outwait the real scheduler's idle
// eviction of the actor, in a file of its own so the wait runs beside the suite instead of adding to it.
// No pins are involved: the client's sockets are disposed (PIN_RELEASE_AFTER_IDLE_MS is for borrowed
// stubs and the library's own connections), so the actor is idle the moment the sessions close.
import { expect, test } from "vitest";
import { disposeSessions, freshCtx, openItx, readAll, sleep } from "./support/client.ts";
import { scheduledAppendFacetSource } from "./support/scheduled-append-facet.ts";

// Crosses the real idle eviction without a client or waitForEvent keeping the actor active. Measured on
// a deployed preview 2026-09-22 (deadline → alarm woke a NEW incarnation): 10 s never (0/6, the alarm
// fired in the first incarnation), 12 s always (16/16), 15 s always (22/22), 20 s always (22/22). The
// edge is Cloudflare's ~10 s idle eviction; 20 s keeps twice that. 22 s sleep; 45 seconds bound the
// deadline plus reconnect and assertions.
test("a disconnected userspace facet's deadline fires after the pins' release without another request", async () => {
  const ctx = freshCtx("schedule_dormant");
  const itx = openItx(ctx);
  await itx.processors.enable("deadlines", {
    source: scheduledAppendFacetSource,
    className: "DeadlinesDurableObject",
  });
  const at = new Date(Date.now() + 20_000).toISOString();
  await itx.facets.get("deadlines").start("dormant", { at });
  disposeSessions();
  await sleep(22_000);
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
}, 45_000);

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
