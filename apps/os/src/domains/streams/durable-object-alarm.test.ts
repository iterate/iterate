import { describe, expect, it, vi } from "vitest";
import { DurableObjectAlarm } from "./durable-object-alarm.ts";

describe("DurableObjectAlarm", () => {
  it("serializes arms without letting a later deadline win", async () => {
    let releaseRead: (value: number | null) => void = () => undefined;
    const firstRead = new Promise<number | null>((resolve) => {
      releaseRead = resolve;
    });
    const h = harness();
    h.getAlarm.mockReturnValueOnce(firstRead);
    const alarm = alarmFor(h.ctx);

    alarm.armNoLaterThan(100);
    alarm.armNoLaterThan(50);
    releaseRead(null);
    await Promise.all(h.waitUntilPromises);

    expect(h.alarmAt()).toBe(50);
    expect(h.setAlarm.mock.calls.map(([at]) => at)).toEqual([100, 50]);
  });

  it("keeps a failed arm rejected on Cloudflare's output gate", async () => {
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

function harness() {
  let alarmAt: number | null = null;
  const waitUntilPromises: Promise<unknown>[] = [];
  const getAlarm = vi.fn(() => Promise.resolve(alarmAt));
  const setAlarm = vi.fn(async (at: number | Date) => {
    alarmAt = typeof at === "number" ? at : at.getTime();
  });
  const ctx = {
    storage: { getAlarm, setAlarm },
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
      void promise.catch(() => undefined);
    },
  } as unknown as DurableObjectState;
  return { alarmAt: () => alarmAt, ctx, getAlarm, setAlarm, waitUntilPromises };
}
