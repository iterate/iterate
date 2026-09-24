// __workers-tests__/context-abort-and-the-watchdog.test.ts — `itx.abort()` ends an incarnation the
// way an eviction does, so what that incarnation left on the ONE alarm meets a fresh incarnation: the
// residency watchdog's deadline (context/residency-watchdog.ts) lives in memory and went with the
// reset, and the alarm it left must wake the fresh incarnation for nothing — no record, no wake record
// — and leave it working. Date is faked (as in residency-watchdog.test.ts) so the window passes in a
// moment; the deployed rows are e2e/context-abort.e2e.test.ts.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, onTestFinished, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { RESIDENCY_WATCHDOG_WINDOW_MS as W } from "../src/context/residency-watchdog.ts";
import { stub } from "./support.ts";

test("the watchdog alarm an aborted incarnation left wakes the fresh one as a no-op; the next call works and nothing is recorded", async () => {
  const ctx = "prj_abort_watchdog";
  const t0 = Date.now();
  vi.useFakeTimers({ now: t0, toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  await stub(ctx).invoke("itx.schedules.list()"); // the inbound call that arms the watchdog
  const alarm = () => runInDurableObject(stub(ctx), (_instance, state) => state.storage.getAlarm());
  expect(await alarm()).toBe(t0 + W);

  const aborted = (await stub(ctx).invoke(["itx", ["abort", "Workers suite"]])) as StreamEvent;
  expect(aborted).toMatchObject({
    type: "events.iterate.com/context/aborted",
    payload: { reason: "Workers suite" },
  });
  await new Promise((resolve) => setTimeout(resolve, 50)); // the reset's zero-delay turn

  vi.setSystemTime(t0 + W);
  expect(await runDurableObjectAlarm(stub(ctx))).toBe(true);
  expect(await alarm()).toBeNull(); // nothing durable was due, and the fresh incarnation armed nothing

  expect(await stub(ctx).invoke("itx.whoami()")).toMatchObject({ path: "/" });
  const events = (
    (await stub(ctx).invoke(["itx", ["readEvents", 0, 500]])) as { events: StreamEvent[] }
  ).events;
  const after = events.slice(events.findIndex((event) => event.offset === aborted.offset) + 1);
  // One wake — the call's, a request's — and nothing from the alarm: no record, no wake record.
  expect(after.map((event) => [event.type, (event.payload as { reason?: string }).reason])).toEqual(
    [["events.iterate.com/stream/woken", "request"]],
  );
});
