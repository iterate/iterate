import { describe, expect, test, vi } from "vitest";
import {
  DeviceEventSessionMetricsTracker,
  subscribePcmBridgeToDeviceEvents,
  type DeviceEvent,
  type DeviceEventCapability,
} from "./device-events.ts";

describe("device push-to-talk event subscription", () => {
  test("maps the physical held/released lifecycle onto the active PCM generation", async () => {
    let callback: ((event: DeviceEvent) => void) | undefined;
    const device: DeviceEventCapability = {
      async subscribeToEvents(next) {
        callback = next;
      },
    };
    const inputStarted = vi.fn(() => true);
    const inputStopped = vi.fn(() => true);

    await subscribePcmBridgeToDeviceEvents(device, { inputStarted, inputStopped });
    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 10,
      snapshot: true,
      source: "physical",
      type: "pushToTalk.stopped",
    });
    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 11,
      source: "physical",
      type: "pushToTalk.started",
    });
    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 12,
      source: "physical",
      type: "pushToTalk.stopped",
    });

    expect(inputStarted).toHaveBeenCalledOnce();
    expect(inputStopped).toHaveBeenCalledOnce();
  });

  test("keeps remote events on the same path and makes unknown events observable", async () => {
    let callback: ((event: DeviceEvent) => void) | undefined;
    const diagnostics: unknown[] = [];
    const device: DeviceEventCapability = {
      async subscribeToEvents(next) {
        callback = next;
      },
    };
    const bridge = {
      inputStarted: vi.fn(() => true),
      inputStopped: vi.fn(() => true),
    };

    await subscribePcmBridgeToDeviceEvents(device, bridge, (diagnostic) =>
      diagnostics.push(diagnostic),
    );
    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 4,
      snapshot: true,
      source: "remote",
      type: "pushToTalk.started",
    });
    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 5,
      source: "system",
      type: "future.event",
    });

    expect(bridge.inputStarted).toHaveBeenCalledOnce();
    expect(diagnostics).toContainEqual({
      code: "unknown-device-event",
      event: expect.objectContaining({ source: "system", type: "future.event" }),
    });
  });

  test("orders call-lifetime events without mistaking the top button for PTT", async () => {
    /*
     * Conversation and PTT edges share one firmware sequence. Treating the
     * top-button call start as unknown would close a newly opened `/pcm`
     * generation; mapping it to inputStarted would capture before the user
     * holds the front button. It must advance ordering and analytics only.
     */
    let callback: ((event: DeviceEvent) => void) | undefined;
    const accepted: DeviceEvent[] = [];
    const diagnostics: unknown[] = [];
    const bridge = {
      inputStarted: vi.fn(() => true),
      inputStopped: vi.fn(() => true),
    };
    await subscribePcmBridgeToDeviceEvents(
      {
        async subscribeToEvents(next) {
          callback = next;
        },
      },
      bridge,
      (diagnostic) => diagnostics.push(diagnostic),
      (event) => accepted.push(event),
    );

    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 70,
      snapshot: true,
      source: "system",
      type: "pushToTalk.stopped",
    });
    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 71,
      source: "physical",
      type: "conversation.started",
    });
    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 72,
      source: "physical",
      type: "pushToTalk.started",
    });

    expect(diagnostics).toEqual([]);
    expect(accepted.map((event) => event.type)).toEqual([
      "pushToTalk.stopped",
      "conversation.started",
      "pushToTalk.started",
    ]);
    expect(bridge.inputStarted).toHaveBeenCalledOnce();
    expect(bridge.inputStopped).not.toHaveBeenCalled();
  });

  test("rejects a sequence gap so a lost button edge cannot commit the wrong turn", async () => {
    let callback: ((event: DeviceEvent) => void) | undefined;
    const diagnostics: unknown[] = [];
    const device: DeviceEventCapability = {
      async subscribeToEvents(next) {
        callback = next;
      },
    };
    const bridge = {
      inputStarted: vi.fn(() => true),
      inputStopped: vi.fn(() => true),
    };
    await subscribePcmBridgeToDeviceEvents(device, bridge, (diagnostic) =>
      diagnostics.push(diagnostic),
    );

    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 20,
      snapshot: true,
      source: "physical",
      type: "pushToTalk.stopped",
    });
    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 22,
      source: "physical",
      type: "pushToTalk.started",
    });

    expect(bridge.inputStarted).not.toHaveBeenCalled();
    expect(bridge.inputStopped).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual({
      actualSequence: 22,
      code: "device-event-sequence-gap",
      expectedSequence: 21,
    });
  });

  test("retains bounded source evidence for a physical PTT proof without retaining an event log", async () => {
    let callback: ((event: DeviceEvent) => void) | undefined;
    const tracker = new DeviceEventSessionMetricsTracker();
    const device: DeviceEventCapability = {
      async subscribeToEvents(next) {
        callback = next;
      },
    };
    const bridge = {
      inputStarted: vi.fn(() => true),
      inputStopped: vi.fn(() => true),
    };

    await subscribePcmBridgeToDeviceEvents(
      device,
      bridge,
      () => undefined,
      (event) => tracker.observe(event),
    );
    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 30,
      snapshot: true,
      source: "system",
      type: "pushToTalk.stopped",
    });
    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 31,
      source: "physical",
      type: "pushToTalk.started",
    });
    callback?.({
      result: 0,
      schemaVersion: 1,
      sequence: 32,
      source: "physical",
      type: "pushToTalk.stopped",
    });

    expect(tracker.metrics()).toEqual({
      acceptedEvents: 3,
      lastEvent: {
        sequence: 32,
        source: "physical",
        type: "pushToTalk.stopped",
      },
      physicalStarts: 1,
      physicalStops: 1,
      physicalConversationStarts: 0,
      physicalConversationEnds: 0,
      remoteStarts: 0,
      remoteStops: 0,
      remoteConversationStarts: 0,
      remoteConversationEnds: 0,
    });
  });
});
