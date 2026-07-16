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
    const alarm = new DurableObjectAlarm(h.ctx);

    const later = alarm.set("later", 100);
    const earlier = alarm.set("earlier", 50);
    releaseRead(null);
    await Promise.all([later, earlier]);

    expect(h.alarmAt()).toBe(50);
    expect(h.setAlarm.mock.calls.map(([at]) => at)).toEqual([50]);
  });

  it("adopts an inherited alarm and re-points after it fires", async () => {
    const h = harness(25);
    const alarm = new DurableObjectAlarm(h.ctx);

    await alarm.set("later", 100);
    expect(h.alarmAt()).toBe(25);

    await alarm.fired(25);
    await alarm.reconcile();
    expect(h.alarmAt()).toBe(100);
  });

  it("re-reads platform state and repairs a failed alarm write", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = harness();
    h.setAlarm.mockRejectedValueOnce(new Error("temporary storage failure"));
    const alarm = new DurableObjectAlarm(h.ctx);

    await expect(alarm.set("posthog", 50)).rejects.toThrow("temporary storage failure");
    await alarm.reconcile();

    expect(h.alarmAt()).toBe(50);
    expect(h.getAlarm).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledOnce();
  });
});

function harness(initialAlarm: number | null = null) {
  let alarmAt = initialAlarm;
  const getAlarm = vi.fn(() => Promise.resolve(alarmAt));
  const setAlarm = vi.fn(async (at: number | Date) => {
    alarmAt = typeof at === "number" ? at : at.getTime();
  });
  const deleteAlarm = vi.fn(async () => {
    alarmAt = null;
  });
  const ctx = {
    storage: { deleteAlarm, getAlarm, setAlarm },
    waitUntil: () => undefined,
  } as unknown as DurableObjectState;
  return { alarmAt: () => alarmAt, ctx, deleteAlarm, getAlarm, setAlarm };
}
