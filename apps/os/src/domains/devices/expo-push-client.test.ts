import { expect, test } from "vitest";
import { getExpoPushReceipt, sendExpoPushNotification } from "./expo-push-client.ts";

test("the Expo adapter distinguishes ticket acceptance from device delivery", async () => {
  const requests: Request[] = [];
  const result = await sendExpoPushNotification(
    {
      body: "Buy milk",
      data: { destination: { kind: "project" }, projectId: "prj_test", requestOffset: 2 },
      expiresAt: Date.parse("2026-07-18T08:05:00Z"),
      title: "Reminder",
      token: "ExponentPushToken[phone]",
    },
    async (request) => {
      requests.push(request);
      return Response.json({ data: { status: "ok", id: "ticket-123" } });
    },
  );

  expect(result).toEqual({ status: "ok", ticketId: "ticket-123" });
  expect(requests).toHaveLength(1);
  await expect(requests[0]!.json()).resolves.toMatchObject({
    to: "ExponentPushToken[phone]",
    title: "Reminder",
    body: "Buy milk",
    expiration: Math.floor(Date.parse("2026-07-18T08:05:00Z") / 1_000),
    data: { projectId: "prj_test", requestOffset: 2 },
  });
});

test("the Expo adapter preserves a per-message ticket rejection", async () => {
  const result = await sendExpoPushNotification(
    {
      body: "Buy milk",
      data: { destination: { kind: "project" }, projectId: "prj_test", requestOffset: 2 },
      expiresAt: Date.parse("2026-07-18T08:05:00Z"),
      title: "Reminder",
      token: "ExponentPushToken[phone]",
    },
    async () =>
      Response.json({
        data: {
          status: "error",
          message: "The device is no longer registered",
          details: { error: "DeviceNotRegistered" },
        },
      }),
  );

  expect(result).toEqual({
    status: "error",
    error: "DeviceNotRegistered",
    message: "The device is no longer registered",
  });
});

test("the Expo adapter names APNs acceptance without claiming device delivery", async () => {
  const result = await getExpoPushReceipt("ticket-123", async () =>
    Response.json({ data: { "ticket-123": { status: "ok" } } }),
  );

  expect(result).toEqual({ status: "accepted-by-push-service" });
});

test("a receipt that Expo has not produced yet remains pending", async () => {
  const result = await getExpoPushReceipt("ticket-123", async () => Response.json({ data: {} }));

  expect(result).toEqual({ status: "pending" });
});
