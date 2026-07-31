// Approval-push suppression, end to end in a browser, told through the new
// Notifications view: the SAME script-triggered approval batch either rings
// your phone or stays silent depending on where you're standing when it
// parks. Lane one — the user is sitting IN the agent thread when the batch
// arrives: the in-thread dialog renders, appends its `project/approval-presented`
// claim inside the device processor's grace window, and the pending push dies
// with the `suppressed` outcome ("Skipped — already on screen"). Lane
// two — the user is on the Notifications view (pointedly NOT the thread):
// nothing claims the batch, the grace window lapses, and the push goes out.
//
// Sign-up plumbing and the RN-web helpers (composer typing, batch-card frame
// gaps) are lifted from specs/mobile/approvals.spec.ts.
//
// Web-platform approximations, deliberate and dev-only: the web build has no
// push channel, so the spec enrolls this browser's device identity
// server-side with a format-valid but undeliverable Expo token. Expo answers
// DeviceNotRegistered at send time (verified against the real API), so lane
// two's deterministic terminal status is "Send failed" — the honest web-build
// account of "the push left the building"; a real phone would read
// Sent/Delivered. That rejection also revokes the fake device, which is why
// the send lane runs LAST.

import { expect, type Page } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { connectItxReady } from "iterate/node";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { resolveAdminSecret } from "../test-support/forged-session.ts";
import { test } from "../test-support/test.ts";

// The browser's device identity, fixed BEFORE the app boots (the web build's
// secure store is localStorage), so the server-side enrollment below and the
// app's Notifications view read the same device stream.
const DEVICE_ID = "spec-web-phone";

test("the approval push is suppressed in the watched thread and sent when you're elsewhere", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const echo = await startEgressEcho();
  try {
    await page.addInitScript((deviceId) => {
      localStorage.setItem("iterate.secure-store.iterate.mobileDeviceId.v1", deviceId);
    }, DEVICE_ID);

    // ── Sign up through the REAL flow (same as approvals.spec.ts). NB: the
    // slug must not contain "notifications" — getByText matches substrings,
    // and the drawer assertion below must not collide with header titles.
    const projectSlug = `mobile-notifs-${Date.now().toString(36)}`;
    await page.goto("/");
    await page.getByPlaceholder("https://os.iterate.com").fill(osBaseUrl);
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Sign in" }).click();
    const popup = await popupPromise;
    await popup.getByTestId("email-login-button").click();
    await signUpWithEmailOtp(popup, {
      email: uniqueSignupEmail("mobile-notifs"),
      projectSlug,
      testInfo,
    });
    await popup.getByRole("button", { name: "Continue" }).click({ timeout: 30_000 });
    await popup.getByRole("button", { name: "Allow access" }).click({ timeout: 30_000 });
    await page.getByText(projectSlug).click({ timeout: 60_000 });
    await spinnerWaiter.settings.run({ disabled: true }, () =>
      page.getByText("New chat").waitFor({ timeout: 30_000 }),
    );
    const projectId = new URL(page.url()).pathname.split("/")[2]!;

    // ── Admin-side setup: a hold rule on the echo host, and the device
    // enrollment the web build cannot do itself (no push channel on web).
    using itx = await connectItxReady({
      auth: { type: "admin-secret", secret: await resolveAdminSecret() },
      baseUrl: osBaseUrl,
      projectId,
    });
    const [rulesConfigured] = await itx.streams.get("/").append({
      type: "events.iterate.com/project/egress-rules-configured",
      payload: {
        rules: [
          {
            ruleKey: "spec-needs-a-human",
            description: "The notifications spec holds these for a human",
            match: { hosts: [new URL(echo.url).hostname] },
            verdict: "hold",
            approvalTimeoutMs: 120_000,
            debounceMs: 2_000,
          },
        ],
      },
    });
    await itx.processor.waitUntilProcessed({ offset: rulesConfigured!.offset, timeoutMs: 15_000 });
    await itx.devices.get(DEVICE_ID).enroll({
      appVersion: "spec",
      expoPushToken: `ExponentPushToken[${DEVICE_ID}-never-deliverable]`,
      label: "Spec web phone",
      notificationsStatus: "granted",
      platform: "ios",
    });
    // Outwait the egress gate's ~5s rules cache before the first script.
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    const parkOneRequest = (marker: string) =>
      `async () => { await fetch(${JSON.stringify(echo.url)} + "?${marker}=1", { method: "POST", body: "${marker}" }).catch(() => {}); }`;

    // ── Lane one: the user is IN the thread when its batch parks. Open a
    // fresh chat, then run the script on exactly that agent path — the
    // in-thread dialog is the claim's trigger, so its render IS the product
    // moment under test.
    await page.getByText("New chat").click();
    await page.getByPlaceholder("Message").waitFor();
    const watchedPath = decodeURIComponent(new URL(page.url()).searchParams.get("path")!);
    const watchedAgent = await itx.agents.get(watchedPath).create();
    void watchedAgent.capabilityHost.runScript(parkOneRequest("watched")).catch(() => {});
    await waitForBatchCardButton(page, "Approve (Face ID)");

    // Off to the Notifications view (project screen → drawer). The claim has
    // fired; by the time we arrive the device processor has settled the push
    // obligation `suppressed` — the row says so, instead of a push having
    // interrupted whoever was reading the thread.
    await page.goBack();
    await page.getByLabel("Open project menu").click();
    // The drawer slides in over ~180ms and the press works mid-slide — but
    // clicking then bakes a half-open drawer into the recording (video-mode
    // freezes the click-moment screenshot under its synthetic pointer, which
    // reads as a clipped drawer to a reviewer). The product is fine: given a
    // beat, the panel settles at translateX(0) at this exact viewport. Wait
    // for the item to stop moving before pressing.
    const notificationsItem = page.getByRole("button", { name: "Notifications" });
    await notificationsItem.waitFor({ timeout: 10_000 });
    await expect
      .poll(
        async () => {
          const before = (await notificationsItem.boundingBox())!.x;
          await page.waitForTimeout(120);
          const after = (await notificationsItem.boundingBox())!.x;
          return after - before;
        },
        { timeout: 5_000 },
      )
      .toBe(0);
    await notificationsItem.click();
    await spinnerWaiter.settings.run({ disabled: true }, () =>
      page.getByText("Skipped — already on screen").waitFor({ timeout: 30_000 }),
    );

    // ── Lane two: the user stays HERE while a different thread's batch
    // parks. No dialog renders, nothing claims the batch, the grace window
    // lapses, and the device processor sends the push — on the web build's
    // undeliverable token that terminally reads "Send failed" (see header).
    const elsewhereAgent = await itx.agents.get("/agents/elsewhere-thread").create();
    void elsewhereAgent.capabilityHost.runScript(parkOneRequest("elsewhere")).catch(() => {});
    await spinnerWaiter.settings.run({ disabled: true }, () =>
      page.getByText("Send failed").waitFor({ timeout: 30_000 }),
    );
    // Both lanes journaled side by side — the comparison this spec exists for.
    await page.getByText("Skipped — already on screen").waitFor({ timeout: 5_000 });

    // ── The row's deep link: tapping the sent push's row lands in the thread
    // that caused it, exactly where tapping the real push would go. (The
    // still-open batch renders its dialog there, whose late claim is a no-op
    // — the push already went out.)
    await page
      .getByTestId(/^notification-row-/)
      .filter({ hasText: "Send failed" })
      .click();
    await spinnerWaiter.settings.run({ disabled: true }, () =>
      page.getByText("elsewhere-thread").first().waitFor({ timeout: 30_000 }),
    );
    expect(decodeURIComponent(page.url())).toContain("/agents/elsewhere-thread");
  } finally {
    await echo.close();
  }
});

/**
 * Wait for a batch-card button while the burst coalesces at the egress door —
 * same frame-gap reasoning as specs/mobile/approvals.spec.ts's helper of the
 * same name: the card mounts on a live stream push, and between React commits
 * the spinner set is momentarily empty.
 */
function waitForBatchCardButton(page: Page, name: string) {
  return spinnerWaiter.settings.run({ disabled: true }, () =>
    page.getByRole("button", { name }).waitFor({ timeout: 30_000 }),
  );
}

/** Same helper as specs/mobile/approvals.spec.ts. */
async function resolveOsBaseUrl(): Promise<string> {
  const configured = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}

/** Same fixture as specs/mobile/approvals.spec.ts. */
function startEgressEcho() {
  return withTunnel({
    path: "/egress-echo",
    async fetch(request) {
      const body = await request.text();
      return Response.json({ body });
    },
  });
}
