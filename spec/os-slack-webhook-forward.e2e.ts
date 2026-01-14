/* eslint-disable no-restricted-syntax -- Mixed browser/API test, some assertions are API-based */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  test,
  expect,
  login,
  createOrganization,
  createProject,
  getOrganizationSlug,
  getProjectSlug,
  sidebarButton,
  signSlackRequest,
} from "./test-helpers.ts";

const OS_API = "http://localhost:5173";

type ReceivedRequest = { url: string; body: string };

async function startMockServer() {
  const received: ReceivedRequest[] = [];

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf-8");
    received.push({ url: req.url ?? "", body });
    res.statusCode = 200;
    res.end("ok");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.describe("Slack webhook forwarding (OS backend)", () => {
  test("forwards webhook to configured local machine", async ({ page }) => {
    const mockServer = await startMockServer();

    try {
      const timestamp = Date.now();
      const testEmail = `slack-forward-${timestamp}+test@nustom.com`;
      const teamId = `T_FORWARD_${timestamp}`;
      const machineName = `Slack Forward ${timestamp}`;

      await login(page, testEmail);
      await createOrganization(page);
      await createProject(page);

      await sidebarButton(page, "Machines").click();
      await page.getByRole("button", { name: "Create Machine" }).click();
      await page.getByPlaceholder("Machine name").fill(machineName);
      await page.getByRole("combobox").click();
      await page.getByRole("option", { name: "Local (Host:Port)" }).click();
      await page.getByPlaceholder("localhost").fill("localhost");
      await page.getByPlaceholder("3001").fill(String(mockServer.port));
      await page.getByRole("button", { name: "Create" }).click();

      await page.getByText(machineName).waitFor();
      const machineLink = page.getByRole("link", { name: machineName });
      const href = await machineLink.getAttribute("href");
      const machineId = href?.split("/").pop();
      expect(machineId).toBeTruthy();

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
        { organizationSlug: orgSlug, projectSlug, teamId, webhookTargetMachineId: machineId },
      );

      expect(seedResult.ok).toBe(true);

      const slackPayload = {
        type: "event_callback",
        team_id: teamId,
        event: { type: "message", ts: `${timestamp}.123456`, text: "Forward me" },
      };
      const body = JSON.stringify(slackPayload);
      const { signature, timestamp: slackTimestamp } = signSlackRequest(body);

      const response = await page.request.post(`${OS_API}/api/integrations/slack/webhook`, {
        data: body,
        headers: {
          "Content-Type": "application/json",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": slackTimestamp,
        },
      });

      expect(response.ok()).toBe(true);

      await expect.poll(() => mockServer.received.length).toBe(1);
      const forwarded = mockServer.received[0];
      expect(forwarded?.url).toBe("/api/integrations/slack/webhook");
      expect(JSON.parse(forwarded?.body ?? "{}")).toMatchObject({ team_id: teamId });
    } finally {
      await mockServer.close();
    }
  });
});
