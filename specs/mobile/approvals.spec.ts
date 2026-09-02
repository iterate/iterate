// The phone approver, entirely inside the conversation: a chat message
// reaches an agent whose scripted turn fires a burst of three fetches at a
// fake API behind a hold-for-approval egress rule. The burst stops at the
// gate as ONE batch, the approval dialog appears in-thread where the human
// is already looking, and the decision releases the fetches — approve means
// 200s, reject means 403s. Each batch then shows up on the Notifications
// view wearing the thread's status at the time of its run.
//
// Web-platform approximations, deliberate and dev-only: secure storage is
// localStorage with confirm()-gated reads standing in for Face ID
// (apps/mobile/src/lib/secure-store.ts), and window.prompt for the native
// reason sheet.

import { expect } from "@playwright/test";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { test } from "../test-support/test.ts";

// Fixed before the app boots so the server-side enrollment below and the app
// read the same device stream.
const DEVICE_ID = "spec-web-approver";

test("approve and reject script bursts from inside the chat thread", async ({
  page,
  helpers,
}, testInfo) => {
  await page.addInitScript((deviceId) => {
    localStorage.setItem("iterate.secure-store.iterate.mobileDeviceId.v1", deviceId);
  }, DEVICE_ID);

  await using fakeApi = await withTunnel(async function (request) {
    const body = await request.text();
    return Response.json({ body });
  });

  await using fixture = await helpers.createMobileFixture("mobile-approvals");
  const { itx } = fixture;

  const [rulesConfigured] = await itx.streams.get("/").append({
    type: "events.iterate.com/project/egress-rules-configured",
    payload: {
      rules: [
        {
          ruleKey: "spec-needs-a-human",
          description: "The mobile approvals spec holds these for a human",
          match: { hosts: [new URL(fakeApi.url).hostname] },
          verdict: "hold",
          approvalTimeoutMs: testInfo.timeout,
          debounceMs: 2_000, // batch the burst as ONE approval even on a slow CI runner
        },
      ],
    },
  });
  await itx.processor.waitUntilProcessed({ offset: rulesConfigured!.offset, timeoutMs: 15_000 });

  await itx.devices.get(DEVICE_ID).enroll({
    appVersion: "spec",
    expoPushToken: `ExponentPushToken[${DEVICE_ID}-never-deliverable]`,
    label: "Spec web approver",
    notificationsStatus: "granted",
    platform: "ios",
  });

  const agent = await fixture.createAgent();
  await page.goto(agent.mobileUrl);

  agent.responses.setOnce(async () => {
    return agent.responses.codemodify(`
      async (itx) => {
        await itx.agent.append({ type: "events.iterate.com/agent/summary-updated", payload: { title: "Refund sweep", activity: "Emailing 3 customers about order refunds" } });

        const responses = await Promise.all([
          fetch(${JSON.stringify(fakeApi.url)} + "?approve-me=0", { method: "POST", body: "approve-me 0" }),
          fetch(${JSON.stringify(fakeApi.url)} + "?approve-me=1", { method: "POST", body: "approve-me 1" }),
          fetch(${JSON.stringify(fakeApi.url)} + "?approve-me=2", { method: "POST", body: "approve-me 2" }),
        ]);

        await itx.chat.sendMessage("approve-me outcomes: " + responses.map(r => r.status).join(", "));
      }
    `);
  });

  await page.getByPlaceholder("Message").click();
  await page.keyboard.insertText("Run the approve-me burst");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Approve all 3 (Face ID)" }).waitFor();

  // Pin the ◷ card before pressing — the decide dialog is its sibling — and
  // watch it flip to ✓ on the SAME card.
  const pendingApprove = await page
    .getByTestId(/^activity-card-/)
    .filter({ has: page.getByLabel("approval pending", { exact: true }) })
    .getAttribute("data-testid");
  page.once("dialog", (dialog) => void dialog.accept().catch(() => {}));
  await page.getByRole("button", { name: "Approve all 3 (Face ID)" }).click();
  await page.getByTestId(pendingApprove!).getByLabel("approved", { exact: true }).waitFor();
  await page.getByText(/approve-me outcomes: 200, 200, 200/).waitFor();

  agent.responses.setOnce(async () => {
    return agent.responses.codemodify(`
      async (itx) => {
        await itx.agent.append({ type: "events.iterate.com/agent/summary-updated", payload: { title: "Invoice chase", activity: "Preparing payment reminders" } });
        await itx.agent.append({ type: "events.iterate.com/agent/summary-updated", payload: { activity: "Requesting payment for 3 overdue invoices" } });

        const responses = await Promise.all([
          fetch(${JSON.stringify(fakeApi.url)} + "?reject-me=0", { method: "POST", body: "reject-me 0" }),
          fetch(${JSON.stringify(fakeApi.url)} + "?reject-me=1", { method: "POST", body: "reject-me 1" }),
          fetch(${JSON.stringify(fakeApi.url)} + "?reject-me=2", { method: "POST", body: "reject-me 2" }),
        ]);

        await itx.chat.sendMessage("reject-me outcomes: " + responses.map(r => r.status).join(", "));
      }
    `);
  });

  await page.getByPlaceholder("Message").click();
  await page.keyboard.insertText("Run the reject-me burst");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Reject all" }).waitFor();

  const pendingReject = await page
    .getByTestId(/^activity-card-/)
    .filter({ has: page.getByLabel("approval pending", { exact: true }) })
    .getAttribute("data-testid");
  page.once(
    "dialog",
    (dialog) => void dialog.accept("wrong recipient — use the staging address").catch(() => {}),
  );
  await page.getByRole("button", { name: "Reject all" }).click();
  await page.getByTestId(pendingReject!).getByLabel("rejected", { exact: true }).waitFor();
  await page.getByText(/reject-me outcomes: 403, 403, 403/).waitFor();

  const approvedCard = page
    .getByTestId(/^activity-card-/)
    .filter({ has: page.getByLabel("approved", { exact: true }) });
  await approvedCard.click();
  await approvedCard.getByRole("button", { name: "Approvals" }).click();
  await approvedCard.getByText("Approved", { exact: true }).waitFor();
  await approvedCard.getByText("The mobile approvals spec holds these for a human").waitFor();
  await approvedCard.getByLabel("approved", { exact: true }).click(); // collapse back

  await page.goBack();
  await page.getByLabel("Open project menu").click();
  await page.getByRole("button", { name: "/notifications ›", exact: true }).click();

  // Expanding a row can push its sibling out of FlatList's render window —
  // collapse before moving on.
  const threadName = agent.path.replace(/^\/agents\//, "");
  const batchRows = page
    .getByTestId(/^notification-row-/)
    .filter({ has: page.getByText("Approvals needed", { exact: true }) });
  const rejectRow = batchRows.filter({ hasText: "reject-me" });
  await rejectRow.click();
  const rejectContext = page.getByRole("link", { name: /Invoice chase/ });
  await rejectContext.waitFor();
  expect(await rejectContext.textContent()).toBe(
    `${threadName} · Invoice chase — Requesting payment for 3 overdue invoices`,
  );
  await rejectRow.click();

  const approveRow = batchRows.filter({ hasText: "approve-me" });
  await approveRow.click();
  const approveContext = page.getByRole("link", { name: /Refund sweep/ });
  await approveContext.waitFor();
  expect(await approveContext.textContent()).toBe(
    `${threadName} · Refund sweep — Emailing 3 customers about order refunds`,
  );

  await approveContext.click();
  await page.getByPlaceholder("Message").waitFor();
  expect(decodeURIComponent(new URL(page.url()).searchParams.get("path")!)).toBe(agent.path);
});
