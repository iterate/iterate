// __workers-tests__/alarm-overdue-watch.test.ts — THE OVERDUE WATCH (src/alarm-coordinator.ts), the
// workaround for an alarm Cloudflare holds past its time, inside workerd with Date faked. Every
// time here is years out, so workerd never delivers an alarm on its own (the harness does, on
// demand), and an armed alarm is a held one once the faked Date passes it: the watch must write it
// again for now — while a call holds the context, and at a fresh incarnation's birth — and log each
// re-arm as the platform-failure warn the prd fault alarm counts and its telemetry pin waits out
// (scripts/ci/prd-fault-alarm.ts). Date starts a minute before the schedule, so the schedule is the
// context's earliest deadline.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, onTestFinished, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { ALARM_OVERDUE_AFTER_MS } from "../src/alarm-coordinator.ts";
import { owedAlarmOf, releasePins, stub, until } from "./support.ts";

const at = Date.parse("2035-01-01T00:00:00Z");

test("WHILE A CALL HOLDS THE CONTEXT: an alarm still undelivered ALARM_OVERDUE_AFTER_MS past its time is written again for now, one warn; the delivery it gets runs the pass", async () => {
  const ctx = "prj_overdue_watch_held";
  const warn = spyOnWarn();
  await scheduleAt(ctx);
  expect(await alarmOf(ctx)).toBe(at);
  vi.setSystemTime(at + ALARM_OVERDUE_AFTER_MS);
  const waiting = stub(ctx).invoke([
    "itx",
    ["waitForEvent", { type: "reminder/due", timeoutMs: 10_000 }],
  ]) as Promise<StreamEvent>;
  await until("the alarm re-armed", async () => (await alarmOf(ctx)) !== at);
  expect({ alarm: await alarmOf(ctx), rearms: rearmWarns(warn) }).toEqual({
    alarm: at + ALARM_OVERDUE_AFTER_MS,
    rearms: [
      {
        event: "iterate-context.platform-failure-alarm-rearm",
        namespace: "iterate-context",
        message: "the runtime held an armed alarm past its time; re-armed it for now",
        name: expect.stringContaining(ctx),
        armedAt: new Date(at).toISOString(),
        overdueMs: ALARM_OVERDUE_AFTER_MS,
        rearms: 1,
      },
    ],
  });
  expect(await runDurableObjectAlarm(stub(ctx))).toBe(true);
  expect(await waiting).toMatchObject({ type: "reminder/due" });
  expect(await owedAlarmOf(stub(ctx))).toBeNull(); // the schedule is spent: nothing durable is owed
});

test("AT BIRTH: a fresh incarnation finds its stored alarm overdue and writes it again for now; no call held, no further re-arm", async () => {
  const ctx = "prj_overdue_watch_birth";
  const warn = spyOnWarn();
  await scheduleAt(ctx);
  await releasePins(ctx);
  await evictDurableObject(stub(ctx));
  vi.setSystemTime(at + 60_000);
  await stub(ctx).invoke("itx.schedules.list()");
  expect({ alarm: await alarmOf(ctx), rearms: rearmWarns(warn) }).toMatchObject({
    alarm: at + 60_000,
    rearms: [{ armedAt: new Date(at).toISOString(), overdueMs: 60_000, rearms: 1 }],
  });
});

/** A fresh context, Date frozen a minute before `at` until the test finishes (timers stay real),
 *  whose earliest deadline is a schedule at `at`. */
async function scheduleAt(ctx: string) {
  vi.useFakeTimers({ now: at - 60_000, toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  await stub(ctx).invoke([
    "itx",
    "schedules",
    [
      "set",
      {
        key: "reminder",
        when: { at: new Date(at).toISOString() },
        events: [{ type: "reminder/due" }],
      },
    ],
  ]);
}

function spyOnWarn() {
  return vi.spyOn(console, "warn");
}

function rearmWarns(warn: ReturnType<typeof spyOnWarn>) {
  return warn.mock.calls
    .map(([line]) => line as { event?: string })
    .filter((line) => line?.event === "iterate-context.platform-failure-alarm-rearm");
}

function alarmOf(ctx: string): Promise<number | null> {
  return runInDurableObject(stub(ctx), (_instance, state) => state.storage.getAlarm());
}
