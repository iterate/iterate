import { describe, expect, it, vi } from "vitest";
import { DurableObjectAlarm } from "./durable-object-alarm.ts";

describe("DurableObjectAlarm", () => {
  it("serializes arms without letting a later deadline win", async () => {
    let releaseRead: (value: number | null) => void = () => undefined;
    const read = new Promise<number | null>((resolve) => {
      releaseRead = resolve;
    });
    const h = harness();
    h.getAlarm.mockReturnValueOnce(read);
    const alarm = alarmFor(h.ctx);

    alarm.armNoLaterThan(100);
    alarm.armNoLaterThan(50);
    releaseRead(null);
    await Promise.all(h.waitUntilPromises);

    expect(h.alarmAt()).toBe(50);
    expect(h.setAlarm.mock.calls.map(([at]) => at)).toEqual([100, 50]);
  });

  it("makes constructor arms inert once the alarm turn begins", async () => {
    const h = harness(50);
    const alarm = alarmFor(h.ctx);

    alarm.armNoLaterThan(25);
    alarm.begin();
    await alarm.complete(null);
    await Promise.all(h.waitUntilPromises);

    expect(h.setAlarm).not.toHaveBeenCalled();
    expect(h.deleteAlarm).toHaveBeenCalledOnce();
    expect(h.alarmAt()).toBeNull();
  });

  it("publishes the exact owner minimum after success", async () => {
    const h = harness(50);
    const alarm = alarmFor(h.ctx);

    alarm.begin();
    await alarm.complete(100);

    expect(h.setAlarm).toHaveBeenCalledOnce();
    expect(h.setAlarm).toHaveBeenCalledWith(100);
    expect(h.alarmAt()).toBe(100);
  });

  it("lets work arriving during the exact write move the replacement earlier", async () => {
    let releaseWrite: () => void = () => undefined;
    const h = harness(50);
    h.setAlarm.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = () => {
            h.setAlarmValue(100);
            resolve();
          };
        }),
    );
    const alarm = alarmFor(h.ctx);

    alarm.begin();
    const completion = alarm.complete(100);
    await vi.waitFor(() => expect(h.setAlarm).toHaveBeenCalledOnce());
    alarm.armNoLaterThan(75);
    releaseWrite();
    await completion;
    await Promise.all(h.waitUntilPromises);

    expect(h.alarmAt()).toBe(75);
    expect(h.setAlarm.mock.calls.map(([at]) => at)).toEqual([100, 75]);
  });

  it("does not replace Cloudflare's native retry on failure", () => {
    const h = harness(null);
    const alarm = alarmFor(h.ctx);

    alarm.begin();

    expect(h.setAlarm).not.toHaveBeenCalled();
    expect(h.deleteAlarm).not.toHaveBeenCalled();
  });

  it("keeps a failed ordinary arm rejected on the output gate", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = harness();
    h.setAlarm.mockRejectedValueOnce(new Error("storage unavailable"));
    const alarm = alarmFor(h.ctx);

    alarm.armNoLaterThan(50);
    await expect(h.waitUntilPromises.at(-1)).rejects.toThrow("storage unavailable");

    expect(error).toHaveBeenCalledWith({
      schema: "iterate.stream-alarm.v1",
      message: "stream_alarm_arm_failed",
      operation: "stream.arm_alarm",
      outcome: "failed",
      errorName: "Error",
      projectId: "prj_test",
      streamId: "stream-test",
    });
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
  return {
    alarmAt: () => alarmAt,
    ctx,
    deleteAlarm,
    getAlarm,
    setAlarm,
    setAlarmValue: (at: number | null) => {
      alarmAt = at;
    },
    waitUntilPromises,
  };
}
