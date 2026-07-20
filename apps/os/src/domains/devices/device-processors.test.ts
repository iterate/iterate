import { expect, test, vi } from "vitest";
import { driveProcessor, MemoryStreamNetwork } from "iterate/processors/testing";
import { DeviceProcessor } from "./device-processor-implementation.ts";

const T = {
  created: "events.iterate.com/device/created",
  intent: "events.iterate.com/notification/requested",
  requested: "events.iterate.com/device/notification-requested",
  started: "events.iterate.com/device/notification-attempt-started",
  settled: "events.iterate.com/device/notification-settled",
  ticket: "events.iterate.com/device/notification-ticket-observed",
  revoked: "events.iterate.com/device/revoked",
} as const;

const pendingReceiptDependencies = {
  getReceipt: async () => ({ status: "pending" as const }),
  repointReceiptAlarm: async () => undefined,
};

test("a device notification request becomes one journaled Expo push attempt", async () => {
  const stream = deviceStream();
  const send = vi.fn(async () => {
    expect(stream.events.map((event) => event.type)).toContain(T.started);
    return { status: "ok" as const, ticketId: "ticket-123" };
  });
  const processor = new DeviceProcessor({
    stream,
    path: stream.path,
    projectId: "prj_test",
    now: () => Date.parse("2026-07-18T08:00:00Z"),
    send,
    ...pendingReceiptDependencies,
  });
  const driver = driveProcessor(processor, stream);

  await stream.append(
    {
      type: T.created,
      payload: {
        config: {
          appVersion: "1.0.0",
          encryptedPushToken: {
            algorithm: "AES-GCM-SHA256+DEVICE-PUSH-V1",
            ciphertext: "encrypted-token",
            iv: "initial-vector",
          },
          label: "Misha's iPhone",
          notificationsStatus: "granted",
          ownerId: "usr_misha",
          platform: "ios",
        },
      },
    },
    {
      type: T.requested,
      idempotencyKey: "buy-milk-at-supermarket:v1",
      payload: {
        body: "Buy milk",
        destination: { kind: "project" },
        expiresAt: Date.parse("2026-07-18T08:05:00Z"),
        title: "Reminder",
      },
    },
  );

  await driver.deliver();
  await vi.waitFor(() => expect(stream.events.some((event) => event.type === T.ticket)).toBe(true));

  expect(send).toHaveBeenCalledWith({
    encryptedPushToken: expect.objectContaining({ ciphertext: "encrypted-token", offset: 1 }),
    notification: {
      body: "Buy milk",
      data: {
        destination: { kind: "project" },
        projectId: "prj_test",
        requestOffset: 2,
      },
      expiresAt: Date.parse("2026-07-18T08:05:00Z"),
      title: "Reminder",
    },
  });
  expect(stream.events.map((event) => event.type)).toEqual([
    T.created,
    T.requested,
    T.started,
    T.ticket,
  ]);
  expect(stream.events.at(-1)).toMatchObject({
    idempotencyKey: "device/notification-ticket-observed@2",
    payload: { requestOffset: 2, ticketId: "ticket-123" },
  });
});

test("a project notification intent becomes this device's push obligation", async () => {
  const network = new MemoryStreamNetwork();
  const stream = network.get("/devices/phone");
  const send = vi.fn(async () => ({ status: "ok" as const, ticketId: "ticket-intent" }));
  const driver = driveProcessor(
    new DeviceProcessor({
      stream,
      path: stream.path,
      projectId: "prj_test",
      now: () => Date.parse("2026-07-19T08:00:00Z"),
      send,
      ...pendingReceiptDependencies,
    }),
    stream,
  );
  await stream.append(deviceCreated(), {
    type: T.intent,
    payload: {
      audience: { kind: "project" },
      body: "POST api.stripe.com is waiting for approval.",
      destination: { kind: "approvals", approvalRequestEventOffset: 17 },
      expiresAt: Date.parse("2026-07-19T08:05:00Z"),
      title: "Approval needed",
    },
  });

  await driver.deliver();
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

  expect(network.eventsAt("/")).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/stream/subscription-configured",
      payload: expect.objectContaining({
        subscriptionKey: "notification-intent:/devices/phone",
        selector: { eventTypes: [T.intent] },
        delivery: {
          mode: "push",
          expression: ["streams", ["get", "/devices/phone"], "acceptCrossPost"],
        },
        deliver: "new",
      }),
    }),
  );
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      notification: expect.objectContaining({
        body: "POST api.stripe.com is waiting for approval.",
        data: expect.objectContaining({
          destination: { kind: "approvals", approvalRequestEventOffset: 17 },
        }),
      }),
    }),
  );
});

test("retrying the same public append does not duplicate a push attempt", async () => {
  const stream = deviceStream();
  const send = vi.fn(async () => ({ status: "ok" as const, ticketId: "ticket-once" }));
  const processor = new DeviceProcessor({
    stream,
    path: stream.path,
    projectId: "prj_test",
    now: () => Date.parse("2026-07-18T08:00:00Z"),
    send,
    ...pendingReceiptDependencies,
  });
  const driver = driveProcessor(processor, stream);
  const request = {
    type: T.requested,
    idempotencyKey: "one-logical-reminder",
    payload: {
      body: "Buy milk",
      destination: { kind: "project" as const },
      expiresAt: Date.parse("2026-07-18T08:05:00Z"),
      title: "Reminder",
    },
  };
  await stream.append(deviceCreated(), request);
  await stream.append(request);

  await driver.deliver();
  await vi.waitFor(() => expect(stream.events.some((event) => event.type === T.ticket)).toBe(true));

  expect(send).toHaveBeenCalledTimes(1);
  expect(stream.events.filter((event) => event.type === T.requested)).toHaveLength(1);
});

test("an expired notification request settles without contacting Expo", async () => {
  const stream = deviceStream();
  const send = vi.fn();
  const processor = new DeviceProcessor({
    stream,
    path: stream.path,
    projectId: "prj_test",
    now: () => Date.parse("2026-07-18T08:10:00Z"),
    send,
    ...pendingReceiptDependencies,
  });
  const driver = driveProcessor(processor, stream);
  await stream.append(
    {
      type: T.created,
      payload: {
        config: {
          appVersion: "1.0.0",
          encryptedPushToken: {
            algorithm: "AES-GCM-SHA256+DEVICE-PUSH-V1",
            ciphertext: "encrypted-token",
            iv: "initial-vector",
          },
          label: "Misha's iPhone",
          notificationsStatus: "granted",
          ownerId: "usr_misha",
          platform: "ios",
        },
      },
    },
    {
      type: T.requested,
      payload: {
        body: "Buy milk",
        destination: { kind: "project" },
        expiresAt: Date.parse("2026-07-18T08:05:00Z"),
        title: "Reminder",
      },
    },
  );

  await driver.deliver();

  expect(send).not.toHaveBeenCalled();
  expect(stream.events.at(-1)).toMatchObject({
    type: T.settled,
    idempotencyKey: "device/notification-settled@2",
    payload: { requestOffset: 2, outcome: { kind: "expired" } },
  });
});

test("a started attempt from a lost incarnation settles uncertain and is never re-sent", async () => {
  const stream = deviceStream();
  const send = vi.fn();
  const processor = new DeviceProcessor({
    stream,
    path: stream.path,
    projectId: "prj_test",
    now: () => Date.parse("2026-07-18T08:00:00Z"),
    send,
    ...pendingReceiptDependencies,
  });
  const driver = driveProcessor(processor, stream);
  await stream.append(
    {
      type: T.created,
      payload: {
        config: {
          appVersion: "1.0.0",
          encryptedPushToken: {
            algorithm: "AES-GCM-SHA256+DEVICE-PUSH-V1",
            ciphertext: "encrypted-token",
            iv: "initial-vector",
          },
          label: "Misha's iPhone",
          notificationsStatus: "granted",
          ownerId: "usr_misha",
          platform: "ios",
        },
      },
    },
    {
      type: T.requested,
      payload: {
        body: "Approve the held request",
        destination: { kind: "approvals", approvalRequestEventOffset: 42 },
        expiresAt: Date.parse("2026-07-18T08:05:00Z"),
        title: "Approval needed",
      },
    },
    { type: T.started, payload: { requestOffset: 2 } },
  );

  await driver.deliver();

  expect(send).not.toHaveBeenCalled();
  expect(stream.events.at(-1)).toMatchObject({
    type: T.settled,
    payload: {
      requestOffset: 2,
      outcome: {
        kind: "uncertain",
        phase: "expo-send",
        reason: expect.stringContaining("incarnation"),
      },
    },
  });
});

test("an Expo ticket rejection becomes a terminal device outcome", async () => {
  const stream = deviceStream();
  const send = vi.fn(async () => ({
    status: "error" as const,
    error: "DeviceNotRegistered",
    message: "The device is no longer registered",
  }));
  const processor = new DeviceProcessor({
    stream,
    path: stream.path,
    projectId: "prj_test",
    now: () => Date.parse("2026-07-18T08:00:00Z"),
    send,
    ...pendingReceiptDependencies,
  });
  const driver = driveProcessor(processor, stream);
  await stream.append(
    {
      type: T.created,
      payload: {
        config: {
          appVersion: "1.0.0",
          encryptedPushToken: {
            algorithm: "AES-GCM-SHA256+DEVICE-PUSH-V1",
            ciphertext: "encrypted-token",
            iv: "initial-vector",
          },
          label: "Misha's iPhone",
          notificationsStatus: "granted",
          ownerId: "usr_misha",
          platform: "ios",
        },
      },
    },
    {
      type: T.requested,
      payload: {
        body: "Buy milk",
        destination: { kind: "project" },
        expiresAt: Date.parse("2026-07-18T08:05:00Z"),
        title: "Reminder",
      },
    },
  );

  await driver.deliver();
  await vi.waitFor(() =>
    expect(stream.events.some((event) => event.type === T.settled)).toBe(true),
  );

  expect(stream.events.at(-1)).toMatchObject({
    type: T.settled,
    payload: {
      requestOffset: 2,
      outcome: {
        kind: "rejected-by-expo",
        error: "DeviceNotRegistered",
        message: "The device is no longer registered",
      },
    },
  });
  expect(stream.events).toContainEqual(
    expect.objectContaining({
      type: T.revoked,
      payload: { reason: "push-token-invalid" },
    }),
  );
});

test("a notification requested after revocation settles as device unavailable", async () => {
  const stream = deviceStream();
  const send = vi.fn();
  const processor = new DeviceProcessor({
    stream,
    path: stream.path,
    projectId: "prj_test",
    now: () => Date.parse("2026-07-18T08:00:00Z"),
    send,
    ...pendingReceiptDependencies,
  });
  const driver = driveProcessor(processor, stream);
  await stream.append(
    deviceCreated(),
    { type: T.revoked, payload: { reason: "sign-out" } },
    {
      type: T.requested,
      payload: {
        body: "Buy milk",
        destination: { kind: "project" },
        expiresAt: Date.parse("2026-07-18T08:05:00Z"),
        title: "Reminder",
      },
    },
  );

  await driver.deliver();

  expect(send).not.toHaveBeenCalled();
  expect(stream.events.at(-1)).toMatchObject({
    type: T.settled,
    payload: { requestOffset: 3, outcome: { kind: "device-unavailable" } },
  });
});

test("a later Expo receipt records push-service acceptance without claiming device delivery", async () => {
  let now = Date.parse("2026-07-18T08:00:00Z");
  const stream = new MemoryStreamNetwork(() => now).get("/devices/phone");
  const processor = new DeviceProcessor({
    stream,
    path: stream.path,
    projectId: "prj_test",
    now: () => now,
    send: async () => ({ status: "ok", ticketId: "ticket-123" }),
    getReceipt: async () => ({ status: "accepted-by-push-service" }),
    repointReceiptAlarm: async () => undefined,
  });
  const driver = driveProcessor(processor, stream);
  await stream.append(
    {
      type: T.created,
      payload: {
        config: {
          appVersion: "1.0.0",
          encryptedPushToken: {
            algorithm: "AES-GCM-SHA256+DEVICE-PUSH-V1",
            ciphertext: "encrypted-token",
            iv: "initial-vector",
          },
          label: "Misha's iPhone",
          notificationsStatus: "granted",
          ownerId: "usr_misha",
          platform: "ios",
        },
      },
    },
    {
      type: T.requested,
      payload: {
        body: "Buy milk",
        destination: { kind: "project" },
        expiresAt: now + 5 * 60_000,
        title: "Reminder",
      },
    },
  );
  await driver.deliver();
  await vi.waitFor(() => expect(stream.events.some((event) => event.type === T.ticket)).toBe(true));
  await driver.runner.waitUntilEvent({
    offset: stream.events.find((event) => event.type === T.ticket)!.offset,
  });

  now += 15 * 60_000;
  await processor.checkReceipts(driver.state);

  expect(stream.events.at(-1)).toMatchObject({
    type: T.settled,
    payload: {
      requestOffset: 2,
      outcome: { kind: "accepted-by-push-service", ticketId: "ticket-123" },
    },
  });
});

test("a DeviceNotRegistered receipt revokes the token before settling the request", async () => {
  let now = Date.parse("2026-07-18T08:00:00Z");
  const stream = new MemoryStreamNetwork(() => now).get("/devices/phone");
  const processor = new DeviceProcessor({
    stream,
    path: stream.path,
    projectId: "prj_test",
    now: () => now,
    send: async () => ({ status: "ok", ticketId: "ticket-invalid" }),
    getReceipt: async () => ({
      status: "rejected-by-push-service",
      error: "DeviceNotRegistered",
      message: "The device is no longer registered",
    }),
    repointReceiptAlarm: async () => undefined,
  });
  const driver = driveProcessor(processor, stream);
  await stream.append(deviceCreated(), {
    type: T.requested,
    payload: {
      body: "Buy milk",
      destination: { kind: "project" },
      expiresAt: now + 5 * 60_000,
      title: "Reminder",
    },
  });
  await driver.deliver();
  await vi.waitFor(() => expect(stream.events.some((event) => event.type === T.ticket)).toBe(true));
  await driver.runner.waitUntilEvent({
    offset: stream.events.find((event) => event.type === T.ticket)!.offset,
  });

  now += 15 * 60_000;
  await processor.checkReceipts(driver.state);

  expect(stream.events.slice(-2)).toMatchObject([
    { type: T.revoked, payload: { reason: "push-token-invalid" } },
    {
      type: T.settled,
      payload: {
        requestOffset: 2,
        outcome: { kind: "rejected-by-push-service", error: "DeviceNotRegistered" },
      },
    },
  ]);
});

test("a full-journal refold performs no extra vendor calls or home-stream writes", async () => {
  const stream = deviceStream();
  await stream.append(deviceCreated(), {
    type: T.requested,
    payload: {
      body: "Already expired",
      destination: { kind: "project" },
      expiresAt: Date.parse("2026-07-18T07:00:00Z"),
      title: "Reminder",
    },
  });
  const first = new DeviceProcessor({
    stream,
    path: stream.path,
    projectId: "prj_test",
    now: () => Date.parse("2026-07-18T08:00:00Z"),
    send: vi.fn(),
    ...pendingReceiptDependencies,
  });
  await driveProcessor(first, stream).deliver();
  const eventCount = stream.events.length;
  const send = vi.fn();
  const refolded = new DeviceProcessor({
    stream,
    path: stream.path,
    projectId: "prj_test",
    now: () => Date.parse("2026-07-18T08:00:00Z"),
    send,
    ...pendingReceiptDependencies,
  });

  await driveProcessor(refolded, stream).deliver();

  expect(send).not.toHaveBeenCalled();
  expect(stream.events).toHaveLength(eventCount);
});

function deviceStream() {
  return new MemoryStreamNetwork().get("/devices/phone");
}

function deviceCreated() {
  return {
    type: T.created,
    payload: {
      config: {
        appVersion: "1.0.0",
        encryptedPushToken: {
          algorithm: "AES-GCM-SHA256+DEVICE-PUSH-V1" as const,
          ciphertext: "encrypted-token",
          iv: "initial-vector",
        },
        label: "Misha's iPhone",
        notificationsStatus: "granted" as const,
        ownerId: "usr_misha",
        platform: "ios" as const,
      },
    },
  };
}
