import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test("public itx discovers an enrolled device and appends a notification request", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`device-itx-${crypto.randomUUID()}`).create({});
  const projectId = (await project.__describe()).projectId;
  using phone = project.devices.get("phone-test-installation");

  await expect(phone.revoke("sign-out")).resolves.toBeNull();

  await phone.enroll({
    appVersion: "e2e",
    expoPushToken: "ExponentPushToken[e2e-never-sent]",
    label: "E2E phone",
    notificationsStatus: "granted",
    platform: "ios",
  });

  const pushTokenSecretPath = "/secrets/devices/phone-test-installation/expo-push-token";
  using pushTokenSecret = project.secrets.get(pushTokenSecretPath);
  expect(await pushTokenSecret.__describe()).toMatchObject({
    created: true,
    egress: { urls: ["https://exp.host"] },
    hasMaterial: true,
  });

  await phone.enroll({
    appVersion: "e2e-rotated",
    expoPushToken: "ExponentPushToken[e2e-rotated-never-sent]",
    label: "E2E phone",
    notificationsStatus: "granted",
    platform: "ios",
  });

  expect(await project.devices.list()).toContainEqual({
    appVersion: "e2e-rotated",
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
  const deviceEvents = await project.streams.get("/devices/phone-test-installation").getEvents();
  expect(deviceEvents).toContainEqual(
    expect.objectContaining({
      type: "events.iterate.com/device/push-token-updated",
      payload: expect.objectContaining({ pushTokenSecretPath }),
    }),
  );
  expect(JSON.stringify(deviceEvents)).not.toContain("ExponentPushToken");
  expect(JSON.stringify(await project.streams.get(pushTokenSecretPath).getEvents())).not.toContain(
    "ExponentPushToken",
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
  ).resolves.toHaveLength(1);
  expect(projectId).toMatch(/^prj_/);
});
