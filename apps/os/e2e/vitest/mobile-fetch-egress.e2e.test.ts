import { expect, test } from "vitest";
import {
  MobileFetchCapabilities,
  MOBILE_FETCH_TYPES,
} from "../../../mobile/src/lib/mobile-fetch.ts";
import { acknowledgeDeviceNotification } from "../../../mobile/src/lib/notification-acknowledgement.ts";
import { itxScript } from "../test-support/itx-script-builder.ts";
import { runExample } from "../test-support/run-example.ts";
import { withTunnel } from "../test-support/tunnel.ts";
import { adminSecret, deployedBaseUrl, withItxSession } from "./test-helpers.ts";

test("notification acknowledgements replay before subscription and phone HTTP crosses sessions", async () => {
  await using upstream = await withTunnel(
    () =>
      new Response(new Uint8Array([0, 255, 42]), {
        status: 422,
        headers: { "content-type": "application/octet-stream", "x-upstream": "phone-proof" },
      }),
  );
  using callerSession = withItxSession();
  using caller = callerSession.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await caller.projects.get(`phone-replay-${crypto.randomUUID()}`).create({});
  const { projectId } = await project.__describe();
  await project.devices.get("test-phone").enroll({
    appVersion: "e2e",
    expoPushToken: "ExponentPushToken[e2e-never-sent]",
    label: "Test phone",
    notificationsStatus: "granted",
    platform: "ios",
  });
  // The in-app notification remains openable with OS pushes disabled.
  // Do not send a test push to Expo or a person's handset.
  await project.devices.get("test-phone").revoke("disabled");
  const [notification] = await project.devices.get("test-phone").append({
    type: "events.iterate.com/device/notification-requested",
    payload: {
      title: "Use this phone",
      body: "Fetch the controlled test endpoint.",
      destination: { kind: "client-capability", capability: "fetch" },
      expiresAt: Date.now() + 45_000,
    },
  });

  using phoneSession = withItxSession();
  using phone = phoneSession.authenticate({ type: "admin-secret", secret: adminSecret() });
  using phoneProject = phone.projects.get(projectId);
  const target = new MobileFetchCapabilities(fetch, () => true);
  using connection = phone.projects.connect(projectId, {
    path: "/clients/mobile/test-phone",
    description: "Test phone HTTP",
    capabilities: target,
    types: MOBILE_FETCH_TYPES,
  });
  await acknowledgeDeviceNotification({
    project: phoneProject,
    connect: async () => connection,
    deviceId: "test-phone",
    requestOffset: notification.offset,
    notificationDate: Date.now(),
  });
  // Both facts are committed before the script installs either wait.
  const result = await itxScript(project.capabilityHost)
    .vars({ requestOffset: notification.offset, url: new URL(upstream.url).href })
    .execute(async (itx, { requestOffset, url }) => {
      const stream = itx.streams.get("/devices/test-phone");
      const opened = await stream.waitForEvent({
        afterOffset: requestOffset,
        eventTypes: ["events.iterate.com/device/notification-opened"],
        predicate: (event) => event.payload?.requestOffset === requestOffset,
        timeoutMs: 5_000,
      });
      const ready = await stream.waitForEvent({
        afterOffset: requestOffset,
        eventTypes: ["events.iterate.com/device/capability-ready"],
        predicate: (event) => event.payload?.requestOffset === requestOffset,
        timeoutMs: 5_000,
      });
      const interceptor = await itx.egress.intercept(async (request, next) => {
        if (request.url !== url) return await next(request);
        const response = await itx.clients.get("/clients/mobile/test-phone").capabilities.fetch({
          url: request.url,
          method: "GET",
          headers: [...request.headers.entries()],
          body: null,
        });
        return new Response(response.body, { status: response.status, headers: response.headers });
      });
      try {
        const response = await fetch(url);
        return {
          openedOffset: opened.offset,
          readyOffset: ready.offset,
          status: response.status,
          body: [...new Uint8Array(await response.arrayBuffer())],
          header: response.headers.get("x-upstream"),
        };
      } finally {
        await interceptor.release();
      }
    });
  expect(result.success()).toMatchObject({
    status: 422,
    body: [0, 255, 42],
    header: "phone-proof",
  });
  expect(result.success().readyOffset).toBeGreaterThan(result.success().openedOffset);

  connection[Symbol.dispose]();
  // A durable readiness observation cannot keep a released provider alive.
  await expect(
    itxScript(project.capabilityHost)
      .vars({ url: upstream.url })
      .execute(
        async (itx, { url }) =>
          await itx.clients.get("/clients/mobile/test-phone").capabilities.fetch({
            url,
            method: "GET",
            headers: [],
            body: null,
          }),
      ),
  ).rejects.toThrow();
});

test.skipIf(deployedBaseUrl() === null)(
  "sandbox curl waits for the phone and returns its response",
  async () => {
    const fetched: string[] = [];
    await using upstream = await withTunnel(
      () => new Response("fetched by the test phone", { status: 422 }),
    );
    using callerSession = withItxSession();
    using caller = callerSession.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await caller.projects.get(`sandbox-phone-${crypto.randomUUID()}`).create({});
    const { projectId } = await project.__describe();
    console.log(`[phone-fetch-proof] project=${projectId}`);
    await project.devices.get("test-phone").enroll({
      appVersion: "e2e",
      expoPushToken: "ExponentPushToken[e2e-never-sent]",
      label: "Test phone",
      notificationsStatus: "granted",
      platform: "ios",
    });
    await project.devices.get("test-phone").revoke("disabled");
    using phoneSession = withItxSession();
    using phone = phoneSession.authenticate({ type: "admin-secret", secret: adminSecret() });
    using phoneProject = phone.projects.get(projectId);
    const client = new MobileFetchCapabilities(
      async (input, init) => {
        fetched.push(String(input));
        return await fetch(input, init);
      },
      () => true,
    );
    let connection: Disposable | undefined;
    const run = runExample("sandbox-phone-fetch", {
      capabilityHost: project.capabilityHost,
      vars: {
        deviceId: "test-phone",
        targetUrl: upstream.url,
        sandboxPath: "/sandboxes/phone-proof",
      },
    });
    const open = (async () => {
      const notification = await project.streams.get("/devices/test-phone").waitForEvent({
        afterOffset: 0,
        eventTypes: ["events.iterate.com/device/notification-requested"],
        timeoutMs: 90_000,
      });
      await acknowledgeDeviceNotification({
        project: phoneProject,
        connect: async () => {
          const registered = phone.projects.connect(projectId, {
            path: "/clients/mobile/test-phone",
            description: "Test phone HTTP",
            capabilities: client,
            types: MOBILE_FETCH_TYPES,
          });
          connection = registered;
          return registered;
        },
        deviceId: "test-phone",
        requestOffset: notification.offset,
        notificationDate: Date.now(),
      });
    })();
    try {
      const [result] = await Promise.all([run, open]);
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "fetched by the test phone\nHTTP 422\n",
      });
      expect(fetched).toEqual([new URL(upstream.url).href]);
      const forwarded = await project.egress.fetch(upstream.url);
      expect(await forwarded.text()).toBe("fetched by the test phone");
      expect(fetched).toHaveLength(1);
    } finally {
      // Session disposal also revokes registration when the test fails before connect.
      connection?.[Symbol.dispose]();
      await project.sandboxes.get("/sandboxes/phone-proof").destroy();
    }
  },
);
