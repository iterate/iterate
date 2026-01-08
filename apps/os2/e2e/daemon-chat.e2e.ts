import { test, expect } from "@playwright/test";

test.describe("daemon chat", () => {
  test("can create agent and receive chat response", async ({ page, baseURL }) => {
    const agentName = `test-agent-${new Date().toISOString()}`;

    await page.goto(`${baseURL}/daemon/ui`);

    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

    const newAgentInput = page.getByPlaceholder("New agent name...");
    await newAgentInput.fill(agentName);
    await newAgentInput.press("Enter");

    await expect(page.getByRole("heading", { name: agentName })).toBeVisible({ timeout: 30000 });

    const messageInput = page.getByPlaceholder("Type a message...");
    await messageInput.fill("what's 1+2");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByTestId("chat-message").filter({ hasText: "what's 1+2" })).toBeVisible({
      timeout: 30000,
    });

    await expect(
      page.locator('[data-testid="chat-message"][data-role="assistant"]').getByText(/three|3/i),
    ).toBeVisible({ timeout: 60000 });
  });
});
