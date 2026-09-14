import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { scheduledAppendFacetSource } from "../e2e/support/scheduled-append-facet.ts";
import { stub, quiesce } from "./support.ts";

const at = "2035-01-01T00:00:00Z";
async function fire(ctx: string, now = Date.parse(at)) {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  try {
    return await runDurableObjectAlarm(stub(ctx));
  } finally {
    vi.useRealTimers();
  }
}
async function read(ctx: string) {
  return (await stub(ctx).invoke(["itx", ["readEvents", 0, 500]])) as {
    events: { type: string; offset: number; payload?: Record<string, unknown> }[];
  };
}

test("a facet's deadline survives quiesce and eviction; duplicate alarms append one batch", async () => {
  const ctx = "prj_scheduled_eviction";
  const s = stub(ctx);
  await s.invoke([
    "itx",
    "processors",
    [
      "enable",
      "deadlines",
      { source: scheduledAppendFacetSource, className: "DeadlinesDurableObject" },
    ],
  ]);
  await s.invoke(["itx", "facets", ["get", "deadlines"], ["start", "invoice", at]]);
  await quiesce(ctx);
  await evictDurableObject(s);
  // A new incarnation's delivery watchdog must not replace the earlier scheduled deadline.
  await runInDurableObject(s, async (_instance, state) => {
    const alarm = await state.storage.getAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(Date.parse(at));
  });
  expect(await fire(ctx)).toBe(true);
  await runInDurableObject(s, async (instance) => {
    await instance.alarm();
  });
  const events = (await read(ctx)).events;
  expect(events.filter((event) => event.type === "job/timed-out")).toHaveLength(1);
  expect(events.filter((event) => event.type === "job/timeout-audit")).toHaveLength(1);
  expect(await s.invoke("itx.schedules.list()")).toEqual([]);
});

test("paused deadlines remain pending across eviction and resume without an alarm loop", async () => {
  const ctx = "prj_scheduled_paused";
  const s = stub(ctx);
  await s.invoke([
    "itx",
    "schedules",
    ["set", { key: "paused", when: { at }, events: [{ type: "due" }] }],
  ]);
  await s.append({ type: "events.iterate.com/stream/paused", payload: { reason: "maintenance" } });
  await evictDurableObject(s);
  await fire(ctx);
  expect((await read(ctx)).events.filter((event) => event.type === "due")).toEqual([]);
  expect(await s.invoke("itx.schedules.get('paused')")).not.toBeNull();
  await s.append({ type: "events.iterate.com/stream/resumed" });
  expect(await fire(ctx)).toBe(true);
  expect((await read(ctx)).events.filter((event) => event.type === "due")).toHaveLength(1);
});

test("one invalid occurrence is durably failed without partially appending or blocking another", async () => {
  const ctx = "prj_scheduled_failed";
  const s = stub(ctx);
  // This raw historical row simulates a definition whose target validation changed after deployment.
  await runInDurableObject(s, async (_instance, state) => {
    state.storage.sql.exec(
      "CREATE TRIGGER reject_bad BEFORE INSERT ON events WHEN json_extract(NEW.body, '$.type') = 'bad' BEGIN SELECT RAISE(ABORT, 'injected append refusal'); END",
    );
  });
  await s.invoke([
    "itx",
    "schedules",
    ["set", { key: "bad", when: { at }, events: [{ type: "prefix" }, { type: "bad" }] }],
  ]);
  await s.invoke([
    "itx",
    "schedules",
    ["set", { key: "good", when: { at }, events: [{ type: "good" }] }],
  ]);
  await fire(ctx);
  const events = (await read(ctx)).events;
  expect(events.filter((event) => event.type === "prefix")).toEqual([]);
  expect(events.filter((event) => event.type === "good")).toHaveLength(1);
  expect(await s.invoke("itx.schedules.get('bad')")).toMatchObject({
    failure: { error: expect.stringContaining("injected append refusal") },
  });
  await s.invoke("itx.schedules.cancel('bad')");
  expect(await s.invoke("itx.schedules.list()")).toEqual([]);
});

test("more than one alarm budget of due work drains in bounded batches", async () => {
  const ctx = "prj_scheduled_budget";
  const s = stub(ctx);
  await s.append(
    ...Array.from({ length: 33 }, (_, i) => ({
      type: "events.iterate.com/stream/append-scheduled",
      payload: { key: `s${i}`, when: { at }, events: [{ type: "batch/due", payload: { i } }] },
    })),
  );
  expect(await fire(ctx)).toBe(true);
  expect((await read(ctx)).events.filter((event) => event.type === "batch/due")).toHaveLength(32);
  expect(await fire(ctx)).toBe(true);
  const delivered = (await read(ctx)).events.filter((event) => event.type === "batch/due");
  expect(delivered.map((event) => event.payload?.i)).toEqual(
    Array.from({ length: 33 }, (_, i) => i),
  );
  expect(await s.invoke("itx.schedules.list()")).toEqual([]);
});

test("a two-due plus one-future pass leaves only the future alarm", async () => {
  const ctx = "prj_scheduled_no_empty_wake";
  const s = stub(ctx);
  // Remove the default subscriber so this checks the scheduler's own alarm, without delivery work.
  await s.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: { name: "config", target: null },
  });
  const future = "2035-01-01T01:00:00Z";
  await s.append(
    ...[at, at, future].map((deadline, i) => ({
      type: "events.iterate.com/stream/append-scheduled",
      payload: { key: `s${i}`, when: { at: deadline }, events: [{ type: "quiet/due" }] },
    })),
  );
  expect(await fire(ctx)).toBe(true);
  expect(
    await runInDurableObject(s, async (_instance, state) => await state.storage.getAlarm()),
  ).toBe(Date.parse(future));
});
