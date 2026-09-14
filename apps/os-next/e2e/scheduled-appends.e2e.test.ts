import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, disposeSessions, sleep } from "./support/client.ts";
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
  expect(due.source.schedule.definedBy.processor.slug).toBe("reminders");
  expect(due.source.processor).toBeUndefined();
  // Repeating the original durable intent after completion returns its receipt, never a new timer.
  const [receipt] = await itx.append({
    type: definition.type,
    payload: definition.payload,
    idempotencyKey: definition.idempotencyKey,
  });
  expect(receipt.offset).toBe(definition.offset);
  expect(await itx.schedules.list()).toEqual([]);
});

test("pause holds a deadline until resume; session attribution names the definition's author", async () => {
  const itx = openItx(freshCtx("schedule_pause"));
  const [definition] = await itx.schedules.set({
    key: "held",
    when: { at: new Date(Date.now() + 1500).toISOString() },
    events: [{ type: "held/due" }],
  });
  expect((await itx.schedules.get("held")).source.principal.actor).toBe("admin");
  await itx.append({
    type: "events.iterate.com/stream/paused",
    payload: { reason: "maintenance" },
  });
  await sleep(2000);
  expect((await readAll(itx)).some((event) => event.type === "held/due")).toBe(false);
  expect(await itx.schedules.get("held")).not.toBeNull();
  await expect(
    itx.schedules.set({
      key: "new",
      when: { at: "2035-01-01T00:00:00Z" },
      events: [{ type: "new/due" }],
    }),
  ).rejects.toMatchObject({ code: "STREAM_PAUSED" });
  await itx.append({ type: "events.iterate.com/stream/resumed" });
  const due = await itx.waitForEvent({ type: "held/due", afterOffset: definition.offset });
  expect(due.source.schedule.definedBy.principal.actor).toBe("admin");
  expect(due.source.principal).toBeUndefined();
  expect(await itx.schedules.list()).toEqual([]);
});

test("replacing an already-armed deadline with a later instant cannot fire the old batch", async () => {
  const itx = openItx(freshCtx("schedule_later"));
  await itx.schedules.set({
    key: "replace",
    when: { at: new Date(Date.now() + 1500).toISOString() },
    events: [{ type: "old/due" }],
  });
  const at = new Date(Date.now() + 3500).toISOString();
  const [replacement] = await itx.schedules.set({
    key: "replace",
    when: { at },
    events: [{ type: "new/due" }],
  });
  await sleep(2000);
  expect((await readAll(itx)).filter((event) => event.type.endsWith("/due"))).toEqual([]);
  const due = await itx.waitForEvent({ type: "new/due", afterOffset: replacement.offset });
  expect(Date.parse(due.createdAt)).toBeGreaterThanOrEqual(Date.parse(at));
  expect((await readAll(itx)).filter((event) => event.type === "old/due")).toEqual([]);
});

test("client-visible validation and capacity refusals commit nothing; a past deadline fires promptly", async () => {
  const itx = openItx(freshCtx("schedule_refusal"));
  await expect(
    itx.schedules.set({
      key: "invalid",
      when: { at: "tomorrow" },
      events: [{ type: "invalid/due" }],
    }),
  ).rejects.toThrow();
  await expect(
    itx.schedules.set({
      key: "resume",
      when: { at: "2035-01-01T00:00:00Z" },
      events: [{ type: "events.iterate.com/stream/resumed" }],
    }),
  ).rejects.toThrow();
  await expect(
    itx.append(
      ...Array.from({ length: 101 }, (_, i) => ({
        type: "events.iterate.com/stream/append-scheduled",
        payload: {
          key: `s${i}`,
          when: { at: "2035-01-01T00:00:00Z" },
          events: [{ type: "limit/due" }],
        },
      })),
    ),
  ).rejects.toMatchObject({ code: "SCHEDULE_LIMIT" });
  expect(await itx.schedules.list()).toEqual([]);
  const [definition] = await itx.schedules.set({
    key: "past",
    when: { at: "2020-01-01T00:00:00Z" },
    events: [{ type: "past/due" }],
  });
  const due = await itx.waitForEvent({ type: "past/due", afterOffset: definition.offset });
  expect(due.type).toBe("past/due");
  expect(await itx.schedules.list()).toEqual([]);
});

// Crosses the real 60-second facet quiesce deadline without a client or waitForEvent keeping it
// active; 100 seconds bounds the 75-second deadline plus reconnect and assertions.
test("a disconnected userspace facet's deadline fires after idle quiesce without another request", async () => {
  const ctx = freshCtx("schedule_dormant");
  const itx = openItx(ctx);
  await itx.processors.enable("deadlines", {
    source: scheduledAppendFacetSource,
    className: "DeadlinesDurableObject",
  });
  const at = new Date(Date.now() + 75_000).toISOString();
  await itx.facets.get("deadlines").start("dormant", at);
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
