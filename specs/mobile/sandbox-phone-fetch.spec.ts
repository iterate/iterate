import { isIP } from "node:net";
import { expect, type Response as BrowserResponse } from "@playwright/test";
import { runExample } from "../../apps/os/e2e/test-support/run-example.ts";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { test } from "../test-support/test.ts";

test("opening a notification lets sandbox curl fetch through this browser's IP", async ({
  page,
  helpers,
}) => {
  const deviceId = "spec-web-fetch";
  // Give the app and the enrollment below the same installation identity.
  await page.addInitScript((id) => {
    localStorage.setItem("iterate.secure-store.iterate.mobileDeviceId.v1", id);
  }, deviceId);

  const requests: string[] = [];
  await using echo = await withTunnel((request) => {
    if (request.method === "GET") requests.push(new URL(request.url).pathname);
    return Response.json(
      { ip: request.headers.get("cf-connecting-ip") },
      {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
      },
    );
  });
  test.skip(echo.local, "Needs a deployed OS with real sandbox containers.");
  await using fixture = await helpers.createMobileFixture("sandbox-phone-fetch");
  test.info().annotations.push({ type: "project", description: fixture.projectId });
  const { itx } = fixture;
  await itx.devices.get(deviceId).enroll({
    appVersion: "spec",
    expoPushToken: "ExponentPushToken[spec-web-fetch-never-sent]",
    label: "Spec browser",
    notificationsStatus: "granted",
    platform: "ios",
  });
  // Use the real in-app notification; this spec does not send an APNs push.
  await itx.devices.get(deviceId).revoke("disabled");
  await page.getByLabel("Open project menu").click();
  await page.getByRole("button", { name: "/notifications ›", exact: true }).click();

  const browser = await page.evaluate(
    async (url) => (await fetch(url)).json(),
    echo.url + "/browser",
  );
  const server: any = await (await itx.egress.fetch(echo.url + "/server")).json();
  expect(isIP(browser.ip)).not.toBe(0);
  expect(isIP(server.ip)).not.toBe(0);
  expect(server).not.toEqual(browser);

  const targetUrl = echo.url + "/sandbox";
  const run = runExample("sandbox-phone-fetch", {
    capabilityHost: itx.capabilityHost,
    vars: { deviceId, targetUrl, sandboxPath: "/sandboxes/browser-fetch" },
  });
  try {
    // Like notifications.spec.ts: the screen cannot show progress for work it
    // doesn't know about yet. Wait for the event, then let Middlewright handle UI.
    const notification = await itx.streams.get(`/devices/${deviceId}`).waitForEvent({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/device/notification-requested"],
      timeoutMs: 90_000, // Includes the real sandbox's cold boot.
    });
    expect(requests).toEqual(["/browser", "/server"]);

    const browserResponses: BrowserResponse[] = [];
    page.on("response", (response) => {
      if (response.url() === targetUrl) browserResponses.push(response);
    });
    const row = page.getByTestId(`notification-row-${notification.offset}`);
    await row.getByRole("button").click();
    await row.getByText("Phone ready.", { exact: true }).waitFor();

    expect(await run).toMatchObject({
      exitCode: 0,
      stdout: JSON.stringify(browser) + "\nHTTP 200\n",
    });
    expect(browserResponses).toHaveLength(1);
    expect(await browserResponses[0]!.json()).toEqual(browser);
    expect(requests).toEqual(["/browser", "/server", "/sandbox"]);
  } finally {
    await itx.sandboxes.get("/sandboxes/browser-fetch").destroy();
  }
});
