/**
 * Full integration test for Slack webhook flow.
 *
 * Tests the complete flow:
 * 1. OS backend receives Slack webhook
 * 2. Looks up projectConnection by team_id
 * 3. Forwards to machine's daemon
 * 4. Daemon creates agent and sends message to tmux
 * 5. Terminal shows the formatted message
 *
 * Requires both servers running: `pnpm dev`
 */
/* eslint-disable no-restricted-syntax -- Mixed browser/API test, some assertions are API-based */
import {
  test,
  expect,
  login,
  createOrganization,
  createProject,
  sidebarButton,
  getOrganizationSlug,
  getProjectSlug,
  signSlackRequest,
} from "./test-helpers.ts";

const OS_API = "http://localhost:5173";
const DAEMON_CLIENT = "http://localhost:3000";

function uniqueTs(): string {
  return `${Date.now()}.${Math.floor(Math.random() * 1000000)}`;
}

test.describe("Slack Webhook Integration", () => {
  test("webhook forwarded from OS backend appears in daemon terminal", async ({
    page,
    browser,
  }) => {
    const timestamp = Date.now();
    const testEmail = `slack-integration-${timestamp}+test@nustom.com`;
    const testTeamId = `T_TEST_${timestamp}`;

    // 1. Setup via OS backend UI - create org and project
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    // 2. Create a "local" machine pointing to daemon (localhost:3001)
    await sidebarButton(page, "Machines").click();
    await page.getByRole("button", { name: "Create Machine" }).click();

    const machineName = `Slack Webhook Machine ${timestamp}`;
    await page.getByPlaceholder("Machine name").fill(machineName);

    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Local (Host:Port)" }).click();
    await page.getByPlaceholder("localhost").fill("localhost");
    await page.getByPlaceholder("3001").fill("3001");

    await page.getByRole("button", { name: "Create" }).click();
    await page.getByText(machineName).waitFor();

    const machineLink = page.getByRole("link", { name: machineName });
    const href = await machineLink.getAttribute("href");
    const machineId = href?.split("/").pop();
    expect(machineId).toBeTruthy();

    // 3. Seed Slack connection for this project (testing endpoint)
    const orgSlug = getOrganizationSlug(page.url());
    const projectSlug = getProjectSlug(page.url());
    const seedResult = await page.evaluate(
      async ({ organizationSlug, projectSlug, teamId, webhookTargetMachineId }) => {
        const res = await fetch("/api/trpc/testing.seedSlackConnection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationSlug, projectSlug, teamId, webhookTargetMachineId }),
        });
        return { ok: res.ok, status: res.status, text: await res.text() };
      },
      {
        organizationSlug: orgSlug,
        projectSlug,
        teamId: testTeamId,
        webhookTargetMachineId: machineId,
      },
    );
    expect(seedResult.ok).toBe(true);

    // 4. Send webhook to OS backend
    const threadTs = uniqueTs();
    const messageText = `Integration test message ${timestamp}`;
    const slackPayload = {
      type: "event_callback",
      team_id: testTeamId,
      event: {
        type: "message",
        ts: threadTs,
        channel: "C_TEST",
        user: "U_TEST",
        text: messageText,
      },
    };

    const body = JSON.stringify(slackPayload);
    const { signature, timestamp: slackTimestamp } = signSlackRequest(body);
    const webhookResponse = await page.request.post(`${OS_API}/api/integrations/slack/webhook`, {
      data: body,
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": slackTimestamp,
      },
    });

    // Webhook should return "ok" (existing behavior) or success status
    expect(webhookResponse.ok()).toBe(true);

    // 5. Navigate to daemon and verify agent was created
    const daemonPage = await browser.newPage();
    const expectedSlug = `slack-${threadTs.replace(".", "-")}`;

    // Wait a moment for the webhook to be processed and agent created
    await page.waitForTimeout(2000);

    await daemonPage.goto(`${DAEMON_CLIENT}/agents/${expectedSlug}`);

    // 6. Wait for terminal to show the formatted message
    // The terminal should contain the formatted Slack message
    await expect(
      daemonPage.locator('[data-testid="ghostty-terminal"], [data-component="GhosttyTerminal"]'),
    ).toContainText(messageText, { timeout: 15000 });

    await daemonPage.close();
  });

  test.skip("replies in same thread reuse existing agent", async ({
    page: _page,
    browser: _browser,
  }) => {
    // TODO: Implement after basic flow works
    // Send two webhooks with same thread_ts
    // Verify only one agent created
    // Verify both messages appear in terminal
  });

  test.skip("different threads create separate agents", async ({
    page: _page,
    browser: _browser,
  }) => {
    // TODO: Implement after basic flow works
    // Send webhooks with different ts values
    // Verify separate agents created
  });
});
