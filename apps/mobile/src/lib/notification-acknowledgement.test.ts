import { expect, test } from "vitest";
import { acknowledgeDeviceNotification } from "./notification-acknowledgement.ts";

test("opening is recorded before connection finishes; readiness follows registration", async () => {
  const connected = Promise.withResolvers<any>();
  const connecting = Promise.withResolvers<void>();
  const events: any[] = [];
  const project: any = {
    devices: { get: () => ({ append: async (event: any) => events.push(event) }) },
    streams: {
      get: () => ({
        getEvents: async () => [
          {
            offset: 42,
            type: "events.iterate.com/device/notification-requested",
            payload: {
              destination: { kind: "client-capability", capability: "fetch" },
              expiresAt: Date.now() + 60_000,
            },
          },
        ],
      }),
    },
  };
  const acknowledgement = acknowledgeDeviceNotification({
    project,
    connect: () => {
      connecting.resolve();
      return connected.promise;
    },
    deviceId: "phone",
    requestOffset: 42,
    notificationDate: 1_784_361_600_000,
  });
  await connecting.promise;
  expect(events).toMatchObject([{ type: "events.iterate.com/device/notification-opened" }]);
  connected.resolve(project);
  await acknowledgement;
  expect(events).toMatchObject([
    { type: "events.iterate.com/device/notification-opened", payload: { requestOffset: 42 } },
    {
      type: "events.iterate.com/device/capability-ready",
      idempotencyKey: "device-capability-ready:42:fetch",
      payload: { requestOffset: 42, capability: "fetch", clientPath: "/clients/mobile/phone" },
    },
  ]);
});

test("a failed connection leaves an opened observation without claiming readiness", async () => {
  const events: any[] = [];
  const project: any = {
    devices: { get: () => ({ append: async (event: any) => events.push(event) }) },
    streams: {
      get: () => ({
        getEvents: async () => [
          {
            offset: 42,
            type: "events.iterate.com/device/notification-requested",
            payload: {
              destination: { kind: "client-capability", capability: "fetch" },
              expiresAt: Date.now() + 60_000,
            },
          },
        ],
      }),
    },
  };
  await expect(
    acknowledgeDeviceNotification({
      project,
      connect: async () => {
        throw new Error("disconnected");
      },
      deviceId: "phone",
      requestOffset: 42,
      notificationDate: 1_784_361_600_000,
    }),
  ).rejects.toThrow("disconnected");
  expect(events).toMatchObject([{ type: "events.iterate.com/device/notification-opened" }]);
});

test("expired notifications record the tap without registering a capability", async () => {
  const events: any[] = [];
  const project: any = {
    devices: { get: () => ({ append: async (event: any) => events.push(event) }) },
    streams: {
      get: () => ({
        getEvents: async () => [
          {
            offset: 42,
            type: "events.iterate.com/device/notification-requested",
            payload: {
              destination: { kind: "client-capability", capability: "fetch" },
              expiresAt: 1,
            },
          },
        ],
      }),
    },
  };
  const outcome = await acknowledgeDeviceNotification({
    project,
    connect: async () => {
      throw new Error("must not register an expired request");
    },
    deviceId: "phone",
    requestOffset: 42,
    notificationDate: 1_784_361_600_000,
  });
  expect(outcome).toBe("expired");
  expect(events).toMatchObject([{ type: "events.iterate.com/device/notification-opened" }]);
});
