import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StreamDeliveryAlarmBoundary,
  settleStreamCoreBackgroundWork,
} from "./stream-durable-object.ts";

afterEach(() => vi.restoreAllMocks());

describe("settleStreamCoreBackgroundWork", () => {
  it("settles a deployment reset as an observed lifecycle interruption", async () => {
    const reset = Object.assign(new Error("Durable Object reset because its code was updated."), {
      durableObjectReset: true,
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      settleStreamCoreBackgroundWork(() => Promise.reject(reset)),
    ).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith(
      "stream core background work interrupted by durable object lifecycle",
      { message: reset.message },
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("reports an application failure exactly once while settling the waitUntil promise", async () => {
    const failure = new Error("ancestor append rejected");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      settleStreamCoreBackgroundWork(() => Promise.reject(failure)),
    ).resolves.toBeUndefined();

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("stream core background work failed", failure);
  });

  it("also observes a synchronous application failure", async () => {
    const failure = new Error("background work did not start");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      settleStreamCoreBackgroundWork(() => {
        throw failure;
      }),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("stream core background work failed", failure);
  });
});

describe("StreamDeliveryAlarmBoundary", () => {
  it("makes an append own only durable alarm arming, then gives delivery to the alarm turn", async () => {
    const alarm = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<void>();
    const armAlarm = vi.fn(() => alarm.promise);
    const startDelivery = vi.fn(() => delivery.promise);
    const kept: Promise<unknown>[] = [];
    const boundary = new StreamDeliveryAlarmBoundary({
      armAlarm,
      now: () => 123,
      waitUntil: (work) => kept.push(work),
    });

    boundary.scheduleOrRun(startDelivery);

    expect(armAlarm).toHaveBeenCalledWith(123);
    expect(startDelivery).not.toHaveBeenCalled();
    expect(kept).toHaveLength(1);
    expect(kept[0]).not.toBe(delivery.promise);

    alarm.resolve();
    await kept[0];
    expect(startDelivery).not.toHaveBeenCalled();

    boundary.runAlarmTurn(() => boundary.scheduleOrRun(startDelivery));

    expect(startDelivery).toHaveBeenCalledOnce();
    expect(kept).toHaveLength(2);
    let alarmTurnSettled = false;
    void kept[1]!.then(() => {
      alarmTurnSettled = true;
    });
    await Promise.resolve();
    expect(alarmTurnSettled).toBe(false);

    delivery.resolve();
    await kept[1];
    expect(alarmTurnSettled).toBe(true);
  });
});
