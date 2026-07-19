import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test("public itx discovers an enrolled device and appends a notification request", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `device-itx-${crypto.randomUUID()}` });
  const projectId = (await project.__describe()).projectId;
  using phone = project.devices.get("phone-test-installation");

  await phone.enroll({
    appVersion: "e2e",
    expoPushToken: "ExponentPushToken[e2e-never-sent]",
    label: "E2E phone",
    notificationsStatus: "granted",
    platform: "ios",
  });

  expect(await project.devices.list()).toContainEqual({
    appVersion: "e2e",
    created: true,
    deviceId: "phone-test-installation",
    label: "E2E phone",
    lastNotificationOpenedAt: null,
    notificationsStatus: "granted",
    ownerId: expect.any(String),
    platform: "ios",
    revokedAt: null,
  });

  const [request] = await phone.append({
    type: "events.iterate.com/device/notification-requested",
    idempotencyKey: "e2e-expired-notification",
    payload: {
      body: "This expired request must never reach Expo.",
      destination: { kind: "project" },
      expiresAt: 1,
      title: "E2E reminder",
    },
  });

  expect(request).toMatchObject({
    path: "/devices/phone-test-installation",
    type: "events.iterate.com/device/notification-requested",
  });
  expect(await project.streams.get("/devices/phone-test-installation").getEvents()).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/device/notification-settled",
      payload: {
        requestOffset: request.offset,
        outcome: { kind: "expired" },
      },
    }),
  );

  using collaboratorSession = withItxSession();
  using collaboratorItx = collaboratorSession.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: {
      type: "user",
      principal: "device-e2e-collaborator",
      projectScopes: [projectId],
    },
  });
  using collaboratorProject = collaboratorItx.projects.get(projectId);
  using collaboratorPhone = collaboratorProject.devices.get("phone-test-installation");

  await expect(
    collaboratorPhone.append({
      type: "events.iterate.com/device/notification-opened",
      payload: {
        openedAt: new Date().toISOString(),
        requestOffset: request.offset,
      },
    }),
  ).rejects.toThrow("only the enrolling user can append device events");
  expect(projectId).toMatch(/^prj_/);
});
