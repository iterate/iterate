import { expect, test } from "vitest";
import { notificationOpenedEvent, pushNotificationRoute } from "./notification-routing.ts";

test("an approval push focuses its request in the project's approval queue", () => {
  expect(
    pushNotificationRoute({
      destination: { kind: "approvals", approvalRequestEventOffset: 137 },
      projectId: "prj_test",
      requestOffset: 42,
    }),
  ).toEqual({
    pathname: "/project/[projectId]/approvals",
    params: { projectId: "prj_test", approvalRequestEventOffset: "137" },
  });
});

test("opening the same notification retries the same durable observation", () => {
  expect(notificationOpenedEvent(42, 1_784_361_600_000)).toEqual({
    type: "events.iterate.com/device/notification-opened",
    idempotencyKey: "device-notification-opened:42",
    payload: { openedAt: "2026-07-18T08:00:00.000Z", requestOffset: 42 },
  });
});

test("an agent push opens only a well-formed agent path", () => {
  expect(
    pushNotificationRoute({
      destination: { kind: "agent-chat", path: "/agents/mobile/groceries" },
      projectId: "prj_test",
    }),
  ).toEqual({
    pathname: "/project/[projectId]/chat",
    params: { projectId: "prj_test", path: "/agents/mobile/groceries" },
  });
  expect(
    pushNotificationRoute({
      destination: { kind: "agent-chat", path: "/admin" },
      projectId: "prj_test",
    }),
  ).toBeNull();
});
