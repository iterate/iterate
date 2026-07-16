import { describe, expect, it, vi } from "vitest";
import { DurableObjectAlarm } from "./durable-object-alarm.ts";

describe("DurableObjectAlarm", () => {
  it("serializes concurrent desires so a later alarm cannot overwrite an earlier one", async () => {
    let releaseRead: (value: number | null) => void = () => undefined;
    const read = new Promise<number | null>((resolve) => {
      releaseRead = resolve;
    });
    const h = harness();
    h.getAlarm.mockReturnValueOnce(read);
    const alarm = alarmFor(h.ctx);

    const later = alarm.set("later", 100);
    const earlier = alarm.set("earlier", 50);
    releaseRead(null);
    await Promise.all([later, earlier]);

    expect(h.alarmAt()).toBe(50);
    expect(h.setAlarm.mock.calls.map(([at]) => at)).toEqual([50]);
  });

  it("adopts an inherited alarm and re-points after it fires", async () => {
    const h = harness(25);
    const alarm = alarmFor(h.ctx);

    await alarm.set("later", 100);
    expect(h.alarmAt()).toBe(25);

    await alarm.fired(25);
    await alarm.reconcile();
    expect(h.alarmAt()).toBe(100);
  });

  it.each([
    ["posthog", 50, "subscriptions", 100],
    ["subscriptions", 50, "posthog", 100],
  ] as const)(
    "preserves the later %s/%s owner after the earlier %s/%s owner fires",
    async (earlierName, earlierAt, laterName, laterAt) => {
      const h = harness();
      const alarm = alarmFor(h.ctx);
      await alarm.set(laterName, laterAt);
      await alarm.set(earlierName, earlierAt);

      await alarm.fired(earlierAt);
      await alarm.reconcile();

      expect(h.alarmAt()).toBe(laterAt);
    },
  );

  it("re-reads platform state and repairs a failed alarm write", async () => {
    const h = harness();
    h.setAlarm.mockRejectedValueOnce(new Error("temporary storage failure"));
    const alarm = alarmFor(h.ctx);

    await expect(alarm.set("posthog", 50)).rejects.toThrow("temporary storage failure");
    await alarm.reconcile();

    expect(h.alarmAt()).toBe(50);
    expect(h.getAlarm).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed scheduled write rejected on the invocation output gate", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = harness();
    h.setAlarm.mockRejectedValueOnce(new Error("temporary storage failure"));
    const alarm = alarmFor(h.ctx);

    alarm.scheduleNoLaterThan("posthog", 50);
    await expect(h.waitUntilPromises.at(-1)).rejects.toThrow("temporary storage failure");

    expect(h.setAlarm).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith({
      schema: "iterate.stream-alarm.v1",
      message: "stream_alarm_reconciliation_failed",
      operation: "stream.reconcile_alarm",
      outcome: "failed",
      errorName: "Error",
      projectId: "prj_test",
      streamId: "stream-test",
    });
  });

  it("never delays an earlier deadline published by the same owner", async () => {
    const h = harness();
    const alarm = alarmFor(h.ctx);

    alarm.scheduleNoLaterThan("subscriptions", 50);
    alarm.scheduleNoLaterThan("subscriptions", 100);
    await vi.waitFor(() => expect(h.alarmAt()).toBe(50));

    await alarm.fired(50);
    alarm.scheduleNoLaterThan("subscriptions", 100);
    await vi.waitFor(() => expect(h.alarmAt()).toBe(100));
  });
});

function alarmFor(ctx: DurableObjectState): DurableObjectAlarm {
  return new DurableObjectAlarm(ctx, { projectId: "prj_test", streamId: "stream-test" });
}

function harness(initialAlarm: number | null = null) {
  let alarmAt = initialAlarm;
  const waitUntilPromises: Promise<unknown>[] = [];
  const getAlarm = vi.fn(() => Promise.resolve(alarmAt));
  const setAlarm = vi.fn(async (at: number | Date) => {
    alarmAt = typeof at === "number" ? at : at.getTime();
  });
  const deleteAlarm = vi.fn(async () => {
    alarmAt = null;
  });
  const ctx = {
    storage: { deleteAlarm, getAlarm, setAlarm },
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
      void promise.catch(() => undefined);
    },
  } as unknown as DurableObjectState;
  return { alarmAt: () => alarmAt, ctx, deleteAlarm, getAlarm, setAlarm, waitUntilPromises };
}
