import { expect, test } from "vitest";
import { freshCtx, openItx, readAll } from "./support/client.ts";
import {
  scheduledAppendFacetSource,
  scheduledAppendProcessorSource,
} from "./support/scheduled-append-facet.ts";

test("a userspace facet schedules a durable timeout batch, then consumes it without an alarm handler", async () => {
  const itx = openItx(freshCtx("schedule_facet"));
  await itx.processors.enable("deadlines", {
    source: scheduledAppendFacetSource,
    className: "DeadlinesDurableObject",
  });
  const facet = itx.facets.get("deadlines");
  expect(await facet.hasAlarmHandler()).toBe(false);
  const at = new Date(Date.now() + 1500).toISOString();
  const [definition] = await facet.start("invoice", at);
  expect(await itx.schedules.get("deadline:invoice")).toMatchObject({
    scheduledAtOffset: definition.offset,
    when: { at },
  });
  const due = await itx.waitForEvent({ type: "job/timeout-audit", afterOffset: definition.offset });
  expect(Date.parse(due.createdAt)).toBeGreaterThanOrEqual(Date.parse(at));
  await facet.waitUntilProcessed({ offset: due.offset });
  expect((await facet.snapshot()).state).toEqual({ timedOut: ["invoice"], audited: ["invoice"] });
  expect(await itx.schedules.list()).toEqual([]);
  const events = await readAll(itx);
  const occurrence = events.filter((event) => event.type.startsWith("job/"));
  expect(occurrence.map((event) => event.type)).toEqual(["job/timed-out", "job/timeout-audit"]);
  expect(occurrence[1].offset).toBe(occurrence[0].offset + 1);
  expect(occurrence[0].source.schedule).toEqual({
    key: "deadline:invoice",
    scheduledAtOffset: definition.offset,
    at,
  });
  expect(
    events.filter((event) => event.type === "events.iterate.com/stream/append-schedule-completed"),
  ).toHaveLength(1);
});

test("a facet owns multiple independent deadlines, cancels finished work and safely replaces a deadline", async () => {
  const itx = openItx(freshCtx("schedule_cancel"));
  await itx.processors.enable("deadlines", {
    source: scheduledAppendFacetSource,
    className: "DeadlinesDurableObject",
  });
  const facet = itx.facets.get("deadlines");
  const oldAt = new Date(Date.now() + 60_000).toISOString();
  const [old] = await facet.start("slow", oldAt);
  const [finished] = await facet.start("finished", oldAt);
  await facet.finish("finished", finished.offset);
  const at = new Date(Date.now() + 1500).toISOString();
  const [replacement] = await facet.start("slow", at);
  await facet.finish("slow", old.offset); // a stale owner cannot cancel its replacement
  expect((await itx.schedules.get("deadline:slow")).scheduledAtOffset).toBe(replacement.offset);
  expect(await itx.schedules.get("deadline:finished")).toBeNull();
  const due = await itx.waitForEvent({
    type: "job/timeout-audit",
    afterOffset: replacement.offset,
  });
  await facet.waitUntilProcessed({ offset: due.offset });
  expect((await facet.snapshot()).state).toEqual({ timedOut: ["slow"], audited: ["slow"] });
  expect(await itx.schedules.list()).toEqual([]);
});

test("a processor emits idempotent scheduling intent and later reduces the reminder with causal provenance", async () => {
  const itx = openItx(freshCtx("schedule_processor"));
  await itx.processors.enable("reminders", {
    source: scheduledAppendProcessorSource,
    className: "RemindersDurableObject",
  });
  const [opened] = await itx.append({ type: "invoice/opened", payload: { invoiceId: "123" } });
  const due = await itx.waitForEvent({ type: "invoice/reminder-due", afterOffset: opened.offset });
  await itx.facets.get("reminders").waitUntilProcessed({ offset: due.offset });
  expect((await itx.facets.get("reminders").snapshot()).state).toEqual({ reminded: ["123"] });
  const events = await readAll(itx);
  const definition = events.find(
    (event) => event.type === "events.iterate.com/stream/append-scheduled",
  )!;
  expect(definition.source.processor.whileProcessing.offset).toBe(opened.offset);
  expect(due.source.schedule.scheduledAtOffset).toBe(definition.offset);
  expect(due.source.processor.slug).toBe("reminders");
  // Repeating the original durable intent after completion returns its receipt, never a new timer.
  const [receipt] = await itx.append({
    type: definition.type,
    payload: definition.payload,
    idempotencyKey: definition.idempotencyKey,
  });
  expect(receipt.offset).toBe(definition.offset);
  expect(await itx.schedules.list()).toEqual([]);
});
