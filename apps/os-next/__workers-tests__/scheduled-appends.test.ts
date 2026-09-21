import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/next/stream/processor";
import { scheduledAppendFacetSource } from "../e2e/support/scheduled-append-facet.ts";
import { stub, releasePins, until } from "./support.ts";

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

test.each([{ principal: { actor: "admin" } }, { processor: { slug: "reminders", version: "1" } }])(
  "live and replayed occurrences preserve absent attribution fields: %j",
  async (source) => {
    const ctx = `prj_schedule_source_${Object.keys(source)[0]}`;
    const s = stub(ctx);
    await s.append({
      type: "events.iterate.com/stream/append-scheduled",
      payload: { key: "reminder", when: { at }, events: [{ type: "reminder/due" }] },
      source,
    });
    // No afterOffset: this must observe the live commit, not find the occurrence in history.
    const waiting = s.invoke([
      "itx",
      ["waitForEvent", { type: "reminder/due", timeoutMs: 5000 }],
    ]) as Promise<StreamEvent>;
    await s.invoke("itx.schedules.list()");
    await fire(ctx);
    const live = await waiting;
    const replay = (await read(ctx)).events.find((event) => event.type === "reminder/due");
    expect(live.source?.schedule?.definedBy).toStrictEqual(source);
    expect(live).toStrictEqual(replay);
  },
);

test("a facet's deadline survives the release and eviction; duplicate alarms append one batch", async () => {
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
  await s.invoke(["itx", "facets", ["get", "deadlines"], ["start", "invoice", { at }]]);
  await releasePins(ctx);
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

test("an interval coalesces an idle gap across eviction and stops on explicit cancellation", async () => {
  const ctx = "prj_scheduled_interval";
  const s = stub(ctx);
  const receipt = await s.invoke([
    "itx",
    "schedules",
    ["set", { key: "tick", when: { everyMs: 10_000 }, events: [{ type: "tick" }] }],
  ]);
  const schedule = (await s.invoke("itx.schedules.get('tick')")) as { nextAt: string };
  const firstAt = Date.parse(schedule.nextAt);
  await evictDurableObject(s);
  await fire(ctx, firstAt + 65_000);
  const { events: afterFirstTick } = await read(ctx);
  expect(afterFirstTick.filter((event) => event.type === "tick")).toHaveLength(1);
  // The incarnation the alarm constructed says so: the stored alarm was the tick's, and due.
  expect(
    afterFirstTick.filter((event) => event.type === "events.iterate.com/stream/woken").at(-1)
      ?.payload,
  ).toMatchObject({ reason: "alarm" });
  expect(await s.invoke("itx.schedules.get('tick')")).toMatchObject({
    nextAt: new Date(firstAt + 70_000).toISOString(),
  });
  await fire(ctx, firstAt + 65_000); // duplicate delivery at the same wall time
  expect((await read(ctx)).events.filter((event) => event.type === "tick")).toHaveLength(1);
  await fire(ctx, firstAt + 70_000);
  expect((await read(ctx)).events.filter((event) => event.type === "tick")).toHaveLength(2);
  await s.invoke(["itx", "schedules", ["cancel", receipt]]);
  await fire(ctx, firstAt + 80_000);
  expect((await read(ctx)).events.filter((event) => event.type === "tick")).toHaveLength(2);
  expect(await s.invoke("itx.schedules.list()")).toEqual([]);
});

test("a failed interval stays parked across later alarms", async () => {
  const ctx = "prj_scheduled_interval_failed";
  const s = stub(ctx);
  await runInDurableObject(s, async (_instance, state) => {
    state.storage.sql.exec(
      "CREATE TRIGGER reject_tick BEFORE INSERT ON events WHEN json_extract(NEW.body, '$.type') = 'tick' BEGIN SELECT RAISE(ABORT, 'injected tick refusal'); END",
    );
  });
  await s.invoke([
    "itx",
    "schedules",
    [
      "set",
      {
        key: "tick",
        when: { everyMs: 1000 },
        events: [{ type: "tick" }],
      },
    ],
  ]);
  const schedule = (await s.invoke("itx.schedules.get('tick')")) as { nextAt: string };
  await fire(ctx, Date.parse(schedule.nextAt));
  await evictDurableObject(s);
  await fire(ctx, Date.parse(schedule.nextAt) + 60_000);
  expect(await s.invoke("itx.schedules.get('tick')")).toMatchObject({
    failure: {
      error: expect.stringContaining("injected tick refusal"),
    },
  });
  expect(
    (await read(ctx)).events.filter(
      (event) => event.type === "events.iterate.com/stream/append-schedule-failed",
    ),
  ).toHaveLength(1);
});

test.each(["once", "interval"])(
  "a %s occurrence survives a post-commit effect failure without being parked or repeated",
  async (kind) => {
    const ctx = `prj_scheduled_effect_${kind}`;
    const s = stub(ctx);
    await s.invoke([
      "itx",
      "processors",
      [
        "enable",
        "deadlines",
        {
          source: scheduledAppendFacetSource,
          className: "DeadlinesDurableObject",
        },
      ],
    ]);
    await s.invoke([
      "itx",
      "schedules",
      [
        "set",
        {
          key: "remove-facet",
          when: kind === "once" ? { at } : { everyMs: 10_000 },
          events: [
            { type: "postcommit/due" },
            {
              type: "events.iterate.com/stream/subscription-configured",
              payload: { name: "deadlines", target: null },
            },
          ],
        },
      ],
    ]);
    const schedule = (await s.invoke("itx.schedules.get('remove-facet')")) as { nextAt: string };
    const dueAt = Date.parse(schedule.nextAt);
    vi.useFakeTimers({ now: dueAt, toFake: ["Date"] });
    try {
      await runInDurableObject(s, async (instance, state) => {
        const deletion = vi.spyOn(state.facets, "delete").mockImplementation(() => {
          throw new Error("injected post-commit facet deletion failure");
        });
        try {
          await expect(instance.alarm()).rejects.toThrow(
            "injected post-commit facet deletion failure",
          );
          expect(deletion).toHaveBeenCalledOnce();
        } finally {
          deletion.mockRestore();
        }
      });
    } finally {
      vi.useRealTimers();
    }
    await evictDurableObject(s);
    await fire(ctx, dueAt); // recovery sees the committed completion, never the original obligation
    const events = (await read(ctx)).events;
    expect(events.filter((event) => event.type === "postcommit/due")).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.type === "events.iterate.com/stream/append-schedule-completed",
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "events.iterate.com/stream/append-schedule-failed"),
    ).toEqual([]);
    expect(await s.invoke("itx.schedules.get('remove-facet')")).toEqual(
      kind === "once"
        ? null
        : expect.objectContaining({
            nextAt: new Date(dueAt + 10_000).toISOString(),
          }),
    );
    await s.invoke("itx.schedules.cancel('remove-facet')");
  },
);

test("a cold context SUPERSEDES a stale physical alarm nothing durable wants: its first reconcile derives no reason for it, and once the wake's own delivery acks no alarm is left", async () => {
  const ctx = "prj_scheduled_existing_alarm";
  const s = stub(ctx);
  await s.invoke("itx.schedules.list()");
  const deadline = Date.now() + 5000;
  await runInDurableObject(s, async (_instance, state) => {
    await state.storage.setAlarm(deadline);
  });
  await evictDurableObject(s);
  await s.invoke("itx.schedules.list()");
  // The stale time is gone at once (the constructor's reconcile); what may stand is the wake
  // record's delivery claim, 20 s out, until the config row acks it.
  const alarm = await runInDurableObject(s, async (_instance, state) => state.storage.getAlarm());
  expect(alarm === null || alarm > deadline).toBe(true);
  await until(
    "no alarm",
    async () =>
      (await runInDurableObject(s, async (_instance, state) => state.storage.getAlarm())) === null,
  );
});
