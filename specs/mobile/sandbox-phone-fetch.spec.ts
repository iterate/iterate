import { isIP } from "node:net";
import { expect, type Response as BrowserResponse } from "@playwright/test";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { test } from "../test-support/test.ts";

test("an agent's sandbox fetch waits for a notification tap and uses this browser's IP", async ({
  page,
  helpers,
}) => {
  const deviceId = "spec-web-fetch";
  await page.addInitScript((id) => {
    localStorage.setItem("iterate.secure-store.iterate.mobileDeviceId.v1", id);
  }, deviceId);

  const requests: { path: string; headers: Record<string, string> }[] = [];
  await using echo = await withTunnel((request) => {
    const headers = Object.fromEntries(request.headers);
    if (request.method === "GET") requests.push({ path: new URL(request.url).pathname, headers });
    return Response.json(headers, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
      },
    });
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
  // Exercise the real in-app notification without sending an APNs push.
  await itx.devices.get(deviceId).revoke("disabled");
  const agent = await fixture.createAgent();
  await page.goto(agent.mobileUrl);
  const browser = await page.evaluate(
    async (url) => (await fetch(url)).json(),
    echo.url + "/browser",
  );
  const targetUrl = echo.url + "/phone";
  const browserResponses: BrowserResponse[] = [];
  page.on("response", (response) => {
    if (response.url() === targetUrl) browserResponses.push(response);
  });

  agent.responses.setOnce(`
    async (itx) => {
      await itx.agent.append({
        type: "events.iterate.com/agent/summary-updated",
        payload: { title: "Phone fetch", activity: "Starting a sandbox" },
      });
      await itx.chat.sendMessage("Starting the sandbox.");
      const sandbox = itx.sandboxes.get("/sandboxes/browser-fetch");
      await sandbox.create({ instanceType: "lite" });
      await sandbox.exec("true");
      const device = itx.devices.get(${JSON.stringify(deviceId)});
      const stream = itx.streams.get(${JSON.stringify(`/devices/${deviceId}`)});
      const clientPath = ${JSON.stringify(`/clients/mobile/${deviceId}`)};
      const interceptor = await itx.egress.intercept(async (request, next) => {
        if (request.method !== "GET" || request.url !== ${JSON.stringify(targetUrl)}) {
          return await next(request);
        }
        const expiresAt = Date.now() + 45_000;
        const [notification] = await device.append({
          type: "events.iterate.com/device/notification-requested",
          payload: {
            title: "HTTP request waiting for your phone",
            body: "Tap to fetch the echo endpoint using this device's network.",
            destination: { kind: "client-capability", capability: "fetch" },
            expiresAt,
          },
        });
        await itx.chat.sendMessage("The request is waiting. Open Notifications and tap it.");
        await stream.waitForEvent({
          afterOffset: notification.offset,
          eventTypes: ["events.iterate.com/device/notification-opened"],
          predicate: (event) => event.payload?.requestOffset === notification.offset,
          timeoutMs: Math.max(1, expiresAt - Date.now()),
        });
        await stream.waitForEvent({
          afterOffset: notification.offset,
          eventTypes: ["events.iterate.com/device/capability-ready"],
          predicate: (event) => event.payload?.requestOffset === notification.offset
            && event.payload.capability === "fetch" && event.payload.clientPath === clientPath,
          timeoutMs: Math.max(1, expiresAt - Date.now()),
        });
        await itx.chat.sendMessage("Phone connected. Fetching through it now.");
        const response = await itx.clients.get(clientPath).capabilities.doFetch({
          url: request.url,
          method: "GET",
          headers: [...request.headers.entries()],
          body: null,
        });
        return new Response(response.body, { status: response.status, headers: response.headers });
      });
      try {
        const server = await sandbox.exec(${JSON.stringify(`curl --fail --silent --show-error '${echo.url}/server'`)});
        if (server.exitCode !== 0) throw new Error(server.stderr);
        await itx.chat.sendMessage("Server headers: \`" + server.stdout + "\`");
        const phone = await sandbox.exec(
          ${JSON.stringify(`curl --fail --silent --show-error --max-time 80 -H 'x-phone-proof: from-sandbox' '${targetUrl}'`)},
          { timeout: 90_000 },
        );
        if (phone.exitCode !== 0) throw new Error(phone.stderr);
        await itx.chat.sendMessage("Sandbox headers: \`" + phone.stdout + "\`");
      } finally {
        await interceptor.release();
      }
    }
  `);

  try {
    await page.getByPlaceholder("Message").click();
    await page.keyboard.insertText("Fetch the echo endpoint from a sandbox through my phone");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Starting the sandbox.", { exact: true }).waitFor();
    await page.getByText("The request is waiting. Open Notifications and tap it.").waitFor();
    expect(requests.map((request) => request.path)).toEqual(["/browser", "/server"]);
    const server = JSON.parse(
      (await page.getByText(/^Server headers: /).textContent())!.replace("Server headers: ", ""),
    );

    await page.goBack();
    await page.getByLabel("Open project menu").click();
    await page.getByRole("button", { name: "/notifications ›", exact: true }).click();
    const row = page
      .getByTestId(/^notification-row-/)
      .filter({ hasText: "HTTP request waiting for your phone" });
    await row.getByRole("button").click();
    await row.getByText("Phone ready.", { exact: true }).waitFor();

    await page.goBack();
    await page.getByText("Phone fetch", { exact: true }).click();
    await page.getByText("Phone connected. Fetching through it now.").waitFor();
    const resultMessage = page.getByText(/^Sandbox headers: /);
    await resultMessage.waitFor();
    const phone = JSON.parse((await resultMessage.textContent())!.replace("Sandbox headers: ", ""));
    expect(isIP(browser["cf-connecting-ip"])).not.toBe(0);
    expect(isIP(server["cf-connecting-ip"])).not.toBe(0);
    expect(server["cf-connecting-ip"]).not.toBe(browser["cf-connecting-ip"]);
    expect(server).toMatchObject({ "user-agent": expect.stringMatching(/^curl\//) });
    expect(server["x-iterate-client"]).toBeUndefined();
    expect(phone).toMatchObject({
      "cf-connecting-ip": browser["cf-connecting-ip"],
      "user-agent": browser["user-agent"],
      "x-iterate-client": "mobile",
      "x-phone-proof": "from-sandbox",
    });
    expect(browserResponses).toHaveLength(1);
    expect(await browserResponses[0]!.json()).toEqual(phone);
    expect(requests).toEqual([
      { path: "/browser", headers: browser },
      { path: "/server", headers: server },
      { path: "/phone", headers: phone },
    ]);
    await test.info().attach("echo-headers", {
      body: JSON.stringify({ browser, server, phone }, null, 2),
      contentType: "application/json",
    });
  } finally {
    await itx.sandboxes.get("/sandboxes/browser-fetch").destroy();
  }
});
