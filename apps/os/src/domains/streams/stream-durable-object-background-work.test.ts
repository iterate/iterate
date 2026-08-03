import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StreamAlarmArmer,
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

  it("classifies an explicit paused-stream rejection outside error telemetry", async () => {
    const paused = new Error("stream paused: operator maintenance");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      settleStreamCoreBackgroundWork(() => Promise.reject(paused)),
    ).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith("stream core background work reached a paused stream", {
      message: paused.message,
    });
    expect(error).not.toHaveBeenCalled();
  });
});

describe("StreamDeliveryAlarmBoundary", () => {
  it("makes an append own only durable alarm arming, then gives delivery to the alarm turn", async () => {
    const delivery = Promise.withResolvers<void>();
    const armAlarm = vi.fn(() => undefined);
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
    // setAlarm is a storage write: the Durable Object output gate already
    // retains it and atomically suppresses the append response if it fails.
    // An extra waitUntil/catch would only turn that failure into a stranded
    // committed cursor with no alarm.
    expect(kept).toHaveLength(0);

    boundary.runAlarmTurn(() => boundary.scheduleOrRun(startDelivery));

    expect(startDelivery).toHaveBeenCalledOnce();
    expect(kept).toHaveLength(1);
    let alarmTurnSettled = false;
    void kept[0]!.then(() => {
      alarmTurnSettled = true;
    });
    await Promise.resolve();
    expect(alarmTurnSettled).toBe(false);

    delivery.resolve();
    await kept[0];
    expect(alarmTurnSettled).toBe(true);
  });

  it("does not swallow a synchronous alarm-arm failure or start delivery inline", () => {
    const failure = new Error("setAlarm failed");
    const startDelivery = vi.fn(async () => undefined);
    const boundary = new StreamDeliveryAlarmBoundary({
      armAlarm: () => {
        throw failure;
      },
      now: () => 456,
      waitUntil: vi.fn(),
    });

    expect(() => boundary.scheduleOrRun(startDelivery)).toThrow(failure);
    expect(startDelivery).not.toHaveBeenCalled();
  });
});

describe("StreamDeliveryAlarmBoundary scheduled-work marker", () => {
  it("marks an append-armed wake as owed until the alarm turn runs", () => {
    const boundary = new StreamDeliveryAlarmBoundary({
      armAlarm: () => undefined,
      now: () => 123,
      waitUntil: () => undefined,
    });
    expect(boundary.hasScheduledWork).toBe(false);

    // Append turn: work is scheduled, not started — nothing else (no cursor
    // row, no in-flight flag) betrays that a wake is owed, so the quiet-alarm
    // deletion must see this marker or it deletes the just-armed alarm and
    // strands every durable send (the exact e2e-caught regression).
    boundary.scheduleOrRun(() => Promise.resolve());
    expect(boundary.hasScheduledWork).toBe(true);

    boundary.runAlarmTurn(() => undefined);
    expect(boundary.hasScheduledWork).toBe(false);

    // Scheduling from within an alarm turn starts the work directly and owes
    // no future wake.
    boundary.runAlarmTurn(() => boundary.scheduleOrRun(() => Promise.resolve()));
    expect(boundary.hasScheduledWork).toBe(false);
  });
});

describe("StreamAlarmArmer", () => {
  it("writes synchronously, never moves an alarm later, and can re-arm after it fires", () => {
    const setAlarm = vi.fn(async () => undefined);
    const armer = new StreamAlarmArmer({ setAlarm, deleteAlarm: vi.fn(async () => undefined) });

    armer.armNoLaterThan(200);
    expect(setAlarm).toHaveBeenLastCalledWith(200);

    armer.armNoLaterThan(300);
    expect(setAlarm).toHaveBeenCalledOnce();

    armer.armNoLaterThan(100);
    expect(setAlarm).toHaveBeenLastCalledWith(100);

    armer.markFired();
    armer.armNoLaterThan(400);
    expect(setAlarm).toHaveBeenLastCalledWith(400);
    expect(setAlarm).toHaveBeenCalledTimes(3);
  });

  it("restores its in-memory deadline when setAlarm throws synchronously", () => {
    const failure = new Error("storage unavailable");
    const setAlarm = vi
      .fn<(atMs: number) => Promise<void>>()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockResolvedValue(undefined);
    const armer = new StreamAlarmArmer({ setAlarm, deleteAlarm: vi.fn(async () => undefined) });

    expect(() => armer.armNoLaterThan(100)).toThrow("stream alarm arming failed");
    armer.armNoLaterThan(100);

    expect(setAlarm).toHaveBeenCalledTimes(2);
  });
});
