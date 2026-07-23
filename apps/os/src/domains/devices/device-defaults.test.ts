import { describe, expect, test } from "vitest";
import { deviceCreationEvents, type DeviceCreatePayload } from "./device-defaults.ts";

const payload = {
  config: {
    appVersion: "1.0.0",
    label: "Phone",
    notificationsStatus: "granted",
    ownerId: "usr_test",
    platform: "ios",
    pushTokenSecretPath: "/secrets/devices/device-1/expo-push-token",
    pushTokenSecretUpdatedOffset: 42,
  },
} satisfies DeviceCreatePayload;

describe("deviceCreationEvents", () => {
  test("builds the certificate and hosted-processor subscription with payload-free keys", () => {
    const first = deviceCreationEvents({
      deviceId: "device-1",
      payload,
      projectId: "prj_test",
    });
    const retryWithDifferentPayload = deviceCreationEvents({
      deviceId: "device-1",
      payload: { ...payload, config: { ...payload.config, label: "Other phone" } },
      projectId: "prj_test",
    });

    expect(first.map((event) => event.type)).toEqual([
      "events.iterate.com/device/created",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(first.map((event) => event.idempotencyKey)).toEqual(
      retryWithDifferentPayload.map((event) => event.idempotencyKey),
    );
  });
});
