import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, sleep } from "./support/client.ts";
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
  const definition = await facet.start("invoice", { at });
  // The definition as the log holds it — never the live table, which a slow round trip can reach
  // after the deadline fired and emptied it (2026-09-24: `schedules.get` read null).
  expect(
    (await readAll(itx)).find((event) => event.offset === definition.scheduledAtOffset),
  ).toMatchObject({
    type: "events.iterate.com/stream/append-scheduled",
    payload: { key: JSON.stringify(["deadlines", "invoice"]), when: { at } },
  });
  const due = await itx.waitForEvent({
    type: "job/timeout-audit",
    afterOffset: definition.scheduledAtOffset,
  });
  expect(Date.parse(due.createdAt)).toBeGreaterThanOrEqual(Date.parse(at));
  await facet.waitUntilProcessed({ offset: due.offset });
  expect(await facet.snapshot()).toMatchObject({
    state: { timedOut: ["invoice"], audited: ["invoice"] },
  });
  expect(await itx.schedules.list()).toEqual([]);
  const events = await readAll(itx);
  const occurrence = events.filter((event) => event.type.startsWith("job/"));
  expect(occurrence.map((event) => event.type)).toEqual(["job/timed-out", "job/timeout-audit"]);
  expect(occurrence[1]).toMatchObject({ offset: occurrence[0].offset + 1 });
  expect(occurrence[0].source).toMatchObject({
    schedule: {
      key: JSON.stringify(["deadlines", "invoice"]),
      scheduledAtOffset: definition.scheduledAtOffset,
      at,
    },
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
  const old = await facet.start("slow", { at: oldAt });
  const finished = await facet.start("finished", { at: oldAt });
  await facet.finish(finished);
  // 8 s: the replacement, the stale finish and the read below must all land before it fires — a
  // loaded preview can take seconds for two round trips (2026-09-24).
  const at = new Date(Date.now() + 8_000).toISOString();
  const replacement = await facet.start("slow", { at });
  await facet.finish(old); // a stale owner cannot cancel its replacement
  expect(await itx.schedules.get(["deadlines", "slow"])).toMatchObject({
    scheduledAtOffset: replacement.scheduledAtOffset,
  });
  expect(await itx.schedules.get(["deadlines", "finished"])).toBeNull();
  const due = await itx.waitForEvent({
    type: "job/timeout-audit",
    afterOffset: replacement.scheduledAtOffset,
  });
  await facet.waitUntilProcessed({ offset: due.offset });
  expect(await facet.snapshot()).toMatchObject({
    state: { timedOut: ["slow"], audited: ["slow"] },
  });
  expect(await itx.schedules.list()).toEqual([]);
});

test("facet-scoped relative deadlines and serializable receipts keep two instances independent", async () => {
  const itx = openItx(freshCtx("schedule_scoped"));
  for (const name of ["first", "second"]) {
    await itx.processors.enable(name, {
      source: scheduledAppendFacetSource,
      className: "DeadlinesDurableObject",
    });
  }
  // 10 s: the three round trips below must read the row back before it fires (1.5 s flaked,
  // 2026-09-21; a loaded preview can take seconds for two, 2026-09-24)
  const first = await itx.facets.get("first").start("same-job", { afterMs: 10_000 });
  const second = await itx.facets.get("second").start("same-job", { afterMs: 60_000 });
  expect(first).not.toMatchObject({ key: second.key });
  const row = await itx.schedules.get(["first", "same-job"]);
  const definition = (await readAll(itx)).find(
    (event) => event.offset === first.scheduledAtOffset,
  )!;
  expect(Date.parse(row.nextAt) - Date.parse(definition.createdAt)).toBe(10_000);
  await itx.facets.get("second").finish(JSON.parse(JSON.stringify(second)));
  expect(await itx.schedules.get(["second", "same-job"])).toBeNull();
  const due = await itx.waitForEvent({
    type: "job/timeout-audit",
    afterOffset: first.scheduledAtOffset,
  });
  await itx.facets.get("first").waitUntilProcessed({ offset: due.offset });
  await itx.facets.get("second").waitUntilProcessed({ offset: due.offset });
  expect((await itx.facets.get("first").snapshot()).state).toMatchObject({
    timedOut: ["same-job"],
  });
  expect((await itx.facets.get("second").snapshot()).state).toMatchObject({ timedOut: [] });
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
  expect(await itx.facets.get("reminders").snapshot()).toMatchObject({
    state: { reminded: ["123"] },
  });
  const events = await readAll(itx);
  const definition = events.find(
    (event) => event.type === "events.iterate.com/stream/append-scheduled",
  )!;
  expect(definition.source.processor.whileProcessing).toMatchObject({ offset: opened.offset });
  expect(due.source.schedule).toMatchObject({ scheduledAtOffset: definition.offset });
  expect(due.source.schedule.definedBy.processor).toMatchObject({ slug: "reminders" });
  expect(Object.keys(due.source.schedule.definedBy)).toEqual(["processor"]);
  expect(due).toStrictEqual(events.find((event) => event.offset === due.offset));
  expect(due.source.processor).toBeUndefined();
  // Repeating the original durable intent after completion returns its receipt, never a new timer.
  const [receipt] = await itx.append({
    type: definition.type,
    payload: definition.payload,
    idempotencyKey: definition.idempotencyKey,
  });
  expect(receipt).toMatchObject({ offset: definition.offset });
  expect(await itx.schedules.list()).toEqual([]);
});

test("pause holds a deadline until resume; session attribution names the definition's author", async () => {
  const itx = openItx(freshCtx("schedule_pause"));
  // Relative to its own commit, as in the replacement row below: an absolute `now + 1.5 s` from
  // before this first call's birth of the project had already passed when it committed, so it
  // fired before the pause and `schedules.get` read null (2 of 40 runs, 2026-09-24). 8 s, not
  // 2.5: under a loaded preview two round trips can take longer than 2.5 s.
  const definition = await itx.schedules.set({
    key: "held",
    when: { afterMs: 8_000 },
    events: [{ type: "held/due" }],
  });
  const held = await itx.schedules.get("held");
  expect(held).toMatchObject({ source: { principal: { actor: "admin" } } });
  const [paused] = await itx.append({
    type: "events.iterate.com/stream/paused",
    payload: { reason: "maintenance" },
  });
  expect(Date.parse(paused.createdAt), "the pause must land before the deadline").toBeLessThan(
    Date.parse(held.nextAt),
  );
  await sleep(Date.parse(held.nextAt) - Date.now() + 500);
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
  const due = await itx.waitForEvent({
    type: "held/due",
    afterOffset: definition.scheduledAtOffset,
  });
  expect(due.source.schedule.definedBy.principal).toMatchObject({ actor: "admin" });
  expect(Object.keys(due.source.schedule.definedBy)).toEqual(["principal"]);
  expect(due).toStrictEqual((await readAll(itx)).find((event) => event.offset === due.offset));
  expect(due.source.principal).toBeUndefined();
  expect(await itx.schedules.list()).toEqual([]);
});

test("replacing an already-armed deadline with a later instant cannot fire the old batch", async () => {
  const itx = openItx(freshCtx("schedule_later"));
  // The old deadline is relative to its own commit, not to the client's clock: this first call
  // births the project, and a birth slower than an absolute `now + 1.5 s` committed the deadline
  // already past, so it fired at once and there was nothing left to replace (2026-09-24: `at`
  // 09:16:13.141Z committed at 09:16:13.149Z, 1 of 18 runs of this file on a busy preview). 8 s,
  // not 2.5: under a loaded preview the `get` below landed after 2.5 s and read null
  // (2026-09-24).
  await itx.schedules.set({
    key: "replace",
    when: { afterMs: 8_000 },
    events: [{ type: "old/due" }],
  });
  const armed = await itx.schedules.get("replace");
  const at = new Date(Date.now() + 10_000).toISOString();
  const replacement = await itx.schedules.set({
    key: "replace",
    when: { at },
    events: [{ type: "new/due" }],
  });
  const replaced = (await readAll(itx)).find(
    (event) => event.offset === replacement.scheduledAtOffset,
  )!;
  expect(
    Date.parse(replaced.createdAt),
    "the replacement must land while the old deadline is still armed",
  ).toBeLessThan(Date.parse(armed.nextAt));
  await sleep(Date.parse(armed.nextAt) - Date.now() + 500);
  expect((await readAll(itx)).filter((event) => event.type.endsWith("/due"))).toEqual([]);
  const due = await itx.waitForEvent({
    type: "new/due",
    afterOffset: replacement.scheduledAtOffset,
  });
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
  const definition = await itx.schedules.set({
    key: "past",
    when: { at: "2020-01-01T00:00:00Z" },
    events: [{ type: "past/due" }],
  });
  const due = await itx.waitForEvent({
    type: "past/due",
    afterOffset: definition.scheduledAtOffset,
  });
  expect(due).toMatchObject({ type: "past/due" });
  expect(await itx.schedules.list()).toEqual([]);
});

test("a userspace facet consumes recurring events until it cancels its receipt", async () => {
  const itx = openItx(freshCtx("schedule_recurring"));
  await itx.processors.enable("deadlines", {
    source: scheduledAppendFacetSource,
    className: "DeadlinesDurableObject",
  });
  const facet = itx.facets.get("deadlines");
  const receipt = await facet.start("heartbeat", { everyMs: 1000 });
  let second;
  try {
    const first = await itx.waitForEvent({
      type: "job/timeout-audit",
      afterOffset: receipt.scheduledAtOffset,
    });
    second = await itx.waitForEvent({ type: "job/timeout-audit", afterOffset: first.offset });
    expect(second.source.schedule).toMatchObject({ scheduledAtOffset: receipt.scheduledAtOffset });
    const gap = Date.parse(second.source.schedule.at) - Date.parse(first.source.schedule.at);
    expect(gap).toBeGreaterThanOrEqual(1000);
    expect(gap % 1000).toBe(0);
    await facet.waitUntilProcessed({ offset: second.offset });
    expect((await facet.snapshot()).state.timedOut.length).toBeGreaterThanOrEqual(2);
  } finally {
    await facet.finish(receipt);
  }
  expect(await itx.schedules.get(["deadlines", "heartbeat"])).toBeNull();
  const count = (await readAll(itx)).filter((event) => event.type === "job/timed-out").length;
  await sleep(1200);
  expect((await readAll(itx)).filter((event) => event.type === "job/timed-out")).toHaveLength(
    count,
  );
});

test("set with an idempotency key returns the original receipt after completion", async () => {
  const itx = openItx(freshCtx("schedule_receipt_retry"));
  const input = { key: ["facet", "once"], when: { afterMs: 0 }, events: [{ type: "once/due" }] };
  const receipt = await itx.schedules.set(input, { idempotencyKey: "request-1" });
  await itx.waitForEvent({ type: "once/due", afterOffset: receipt.scheduledAtOffset });
  expect(await itx.schedules.set(input, { idempotencyKey: "request-1" })).toEqual(receipt);
  expect(await itx.schedules.list()).toEqual([]);
});

test("inspection rows are cancellation receipts and a stale row cannot cancel a replacement", async () => {
  const itx = openItx(freshCtx("schedule_inspected_receipt"));
  const input = {
    key: ["facet", "deadline"],
    when: { afterMs: 60_000 },
    events: [{ type: "inspected/due" }],
  };
  await itx.schedules.set(input);
  const old = await itx.schedules.get(input.key);
  const replacement = await itx.schedules.set(input);
  await itx.schedules.cancel(old);
  const current = await itx.schedules.get(input.key);
  expect(current).toMatchObject({ scheduledAtOffset: replacement.scheduledAtOffset });
  await itx.schedules.cancel(current);
  expect(await itx.schedules.get(input.key)).toBeNull();
  expect(await itx.schedules.list()).toEqual([]);
});
