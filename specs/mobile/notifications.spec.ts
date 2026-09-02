// Approval-push suppression, end to end in a browser, told through the
// Notifications view. Agents fetch a fake API behind a hold-for-approval
// egress rule, so each fetch stops at the gate until a human decides — and
// the same kind of held approval then either rings your phone or stays
// silent depending on where you're standing:
//
// - watched thread: you're looking at the agent's chat when its approval
//   arrives. The in-thread dialog claims it within the grace window and the
//   pending push settles `suppressed` ("Skipped — already on screen").
// - elsewhere thread: you're on the Notifications view, nothing claims the
//   approval, the grace window lapses, and the push goes out.
// - before-enrollment thread: its approval arrived before this device
//   existed, so no push was ever recorded here. The screen builds a
//   synthetic "Needs approval" row from the project's own records, decidable
//   in place.
//
// Web-platform approximations, deliberate and dev-only: the web build has no
// push channel, so the spec enrolls this browser's device identity
// server-side with a format-valid but undeliverable Expo token. Expo answers
// DeviceNotRegistered at send time (verified against the real API), so the
// sent push reads "Send failed". If the vendor call crosses its bounded
// deadline after the durable attempt starts, the only honest terminal
// status is "Delivery uncertain" — it may have accepted the push, so the
// processor never retries. A real phone would normally read Sent/Delivered.

import { expect } from "@playwright/test";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { test } from "../test-support/test.ts";

// Fixed before the app boots so the server-side enrollment below and the app
// read the same device stream.
const DEVICE_ID = "spec-web-phone";

test("the approval push is suppressed in the watched thread and sent when you're elsewhere", async ({
  page,
  helpers,
}, testInfo) => {
  await page.addInitScript((deviceId) => {
    localStorage.setItem("iterate.secure-store.iterate.mobileDeviceId.v1", deviceId);
  }, DEVICE_ID);

  await using fakeApi = await withTunnel(async function (request) {
    const body = await request.text();
    return Response.json({ operation: request.url.split("/").pop(), done: "you-betcha", body });
  });

  await using fixture = await helpers.createMobileFixture("mobile-notifs");
  const { itx } = fixture;

  const [rulesConfigured] = await itx.streams.get("/").append({
    type: "events.iterate.com/project/egress-rules-configured",
    payload: {
      rules: [
        {
          ruleKey: "spec-needs-a-human",
          description: "The notifications spec holds these for a human",
          match: { hosts: [new URL(fakeApi.url).hostname] },
          verdict: "hold",
          approvalTimeoutMs: testInfo.timeout, // generous - the first one gets decided last
          debounceMs: 2_000,
        },
      ],
    },
  });
  await itx.processor.waitUntilProcessed({ offset: rulesConfigured!.offset, timeoutMs: 15_000 });

  const orphanAgent = await itx.agents.get("/agents/thread-from-before-device-enrollment").create();
  const deployPromise = orphanAgent.capabilityHost.runScript(`
    async () => {
      const response = await fetch("${fakeApi.url}/api/deploy", { method: "post" });
      return { status: response.status, body: await response.json() };
    }
  `);
  const rootStream = itx.streams.get("/");
  const beforeEnrollmentApprovalRequest = await rootStream.waitForEvent({
    afterOffset: 0,
    eventTypes: ["events.iterate.com/project/human-approval-requested"],
    timeoutMs: 30_000, // some slack for cold one-off Worker Loaders
  });
  await rootStream.waitForEvent({
    afterOffset: beforeEnrollmentApprovalRequest.offset,
    eventTypes: ["events.iterate.com/notification/requested"],
    timeoutMs: 15_000,
  });

  // alright we've seen that the approval gets requested, now let's enroll the device
  await itx.devices.get(DEVICE_ID).enroll({
    appVersion: "spec",
    expoPushToken: `ExponentPushToken[${DEVICE_ID}-never-deliverable]`,
    label: "Spec web phone",
    notificationsStatus: "granted",
    platform: "ios",
  });

  // Create an agent normally via the UI. The user can therefore see it and should get the approval UI right there and doesn't need a notification.
  const watchedAgent = await fixture.createAgent();
  await page.goto(watchedAgent.mobileUrl);

  watchedAgent.responses.setOnce(async () => {
    return watchedAgent.responses.codemodify(
      `async (itx) => await fetch("${fakeApi.url}/api/restart", { method: "post" })`,
    );
  });

  await page.getByPlaceholder("Message").click();
  await page.keyboard.insertText("Restart the system pls");
  await page.getByRole("button", { name: "Send" }).click();

  await page.getByRole("button", { name: "Approve (Face ID)" }).waitFor();
  // The dialog above derives from the watched batch's approval, so it is
  // journaled by now — anchor the elsewhere wait past it.
  const watchedApproval = await rootStream.waitForEvent({
    afterOffset: beforeEnrollmentApprovalRequest.offset,
    eventTypes: ["events.iterate.com/project/human-approval-requested"],
    timeoutMs: 15_000,
  });

  await page.goBack();
  await page.getByLabel("Open project menu").click();
  await page.getByRole("button", { name: "/notifications ›", exact: true }).click();
  await page.getByText("Skipped — already on screen").waitFor();
  await page.getByText("Needs approval — no notification reached this device").waitFor();

  // The user is still looking at the "Restart the system pls" screen. Another agent acts elsewhere, so needs a notification for approval.
  const elsewhereAgent = await itx.agents.get("/agents/elsewhere-thread").create();
  await elsewhereAgent.append({
    type: "events.iterate.com/agent/summary-updated",
    payload: { title: "Workaround stale dashboard bug", activity: "Calling the clear-cache API" },
  });
  const clearCachePromise = elsewhereAgent.capabilityHost.runScript(`
    async () => {
      const response = await fetch("${fakeApi.url}/api/clear-cache", { method: "post" });
      return { status: response.status, body: await response.json() };
    }
  `);
  const elsewhereApproval = await rootStream.waitForEvent({
    afterOffset: watchedApproval.offset,
    eventTypes: ["events.iterate.com/project/human-approval-requested"],
    timeoutMs: 30_000,
  });

  // stream-level waiters - the point of this test is the UI *doesn't* know these notifcations are coming, so no spinners or anything
  const deviceStream = itx.streams.get(`/devices/${DEVICE_ID}`);
  const elsewhereDeviceRequest = await deviceStream.waitForEvent({
    afterOffset: 0,
    eventTypes: ["events.iterate.com/notification/requested"],
    predicate: (event) =>
      (event.payload as { approvalRequestEventOffset?: number }).approvalRequestEventOffset ===
      elsewhereApproval.offset,
    timeoutMs: 15_000,
  });
  const attemptStarted = await deviceStream.waitForEvent({
    afterOffset: elsewhereDeviceRequest.offset,
    eventTypes: ["events.iterate.com/device/notification-attempt-started"],
    timeoutMs: 15_000,
  });
  await deviceStream.waitForEvent({
    afterOffset: attemptStarted.offset,
    eventTypes: ["events.iterate.com/device/notification-settled"],
    // EXPO_PUSH_SEND_TIMEOUT_MS (processor-facet-durable-object.ts): the
    // sender waits up to 15s for Expo's answer, then settles regardless.
    // 20s = that plus propagation margin.
    timeoutMs: 20_000,
  });
  const settlements = await deviceStream.getEvents({
    eventTypes: ["events.iterate.com/device/notification-settled"],
  });
  const sendOutcome = (settlements.at(-1)!.payload as any).outcome;

  // Two possible endings because Expo is REAL here (the push client hardcodes
  // https://exp.host): normally it answers DeviceNotRegistered for our fake
  // token ("Send failed"), but if it dawdles past the 15s deadline the
  // product honestly records `uncertain` instead. Making this deterministic
  // needs an injectable push origin the spec could serve itself.
  expect(sendOutcome.kind).toMatch(/^(rejected-by-expo|uncertain)$/);
  const sendStatus = sendOutcome.kind === "uncertain" ? "Delivery uncertain" : "Send failed";
  await page.getByText(sendStatus).waitFor();
  await page.getByText("Skipped — already on screen").waitFor();

  const clearNotif = page.getByTestId(/^notification-row-/).filter({ hasText: "/api/clear-cache" });
  await clearNotif.click(); // expand the row
  await clearNotif.getByText("Awaiting decision").waitFor();

  // The web build's window.prompt stands in for the native reason sheet.
  page.once("dialog", (dialog) => void dialog.accept("I'm a hoarder").catch(() => {}));
  await clearNotif.getByRole("button", { name: "Reject" }).click();
  await clearNotif.getByText(`Rejected because: I'm a hoarder`).waitFor();
  await page.getByRole("link", { name: /Workaround stale dashboard bug/ }).waitFor();

  const deployNotif = page.getByTestId(/^needs-approval-row-/).filter({ hasText: "/api/deploy" });
  await deployNotif.click();
  await deployNotif.getByText("Awaiting decision").waitFor();

  page.once("dialog", (dialog) => void dialog.accept("I hate deploying").catch(() => {}));
  await deployNotif.getByRole("button", { name: "Reject" }).click();
  await deployNotif.getByText("Rejected because: I hate deploying").waitFor();

  expect(await clearCachePromise).toMatchObject({
    result: { status: 403, body: { deniedBy: "human", reason: "I'm a hoarder" } },
  });
  expect(await deployPromise).toMatchObject({
    result: { status: 403, body: { deniedBy: "human", reason: "I hate deploying" } },
  });

  await clearNotif.getByRole("link", { name: "Open thread" }).click();
  await page.getByRole("heading", { name: "Workaround stale dashboard bug" }).waitFor();
  expect(decodeURIComponent(page.url())).toContain("/agents/elsewhere-thread");
});
