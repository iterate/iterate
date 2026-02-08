import { expect } from "@playwright/test";
import { createOrganization, createProject, login, sidebarButton, test } from "./test-helpers.ts";

test.describe("project home webchat", () => {
  test("shows webchat and machine prerequisite", async ({ page }) => {
    const testEmail = `webchat-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    await sidebarButton(page, "Home").click();

    await page.getByRole("button", { name: "New Thread" }).waitFor();
    await page.getByText("No active machine").waitFor();
    await page.getByRole("link", { name: "Open machines" }).waitFor();
    await page.getByTestId("webchat-input").waitFor();
  });

  test("can send and receive in a webchat thread", async ({ page }) => {
    test.skip(
      process.env.WEBCHAT_LLM_SPEC !== "1",
      "Set WEBCHAT_LLM_SPEC=1 to run the LLM-backed webchat spec",
    );

    const testEmail = `webchat-live-${Date.now()}+test@nustom.com`;
    const machineName = `Webchat Machine ${Date.now()}`;

    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    await sidebarButton(page, "Machines").click();
    await page.getByRole("link", { name: "Create Machine" }).click();

    const machineTypeSelect = page.getByRole("combobox");
    if ((await machineTypeSelect.count()) > 0) {
      await machineTypeSelect.click();
      const localOption = page.getByRole("option", { name: "Local (Host:Port)" });
      if ((await localOption.count()) > 0) {
        await localOption.click();
      } else {
        await page.keyboard.press("Escape");
      }
    }

    await page.getByPlaceholder("Machine name").fill(machineName);
    await page.getByRole("button", { name: "Create" }).click();

    await page.getByRole("link", { name: machineName }).waitFor({ timeout: 60000 });
    await page.getByRole("heading", { name: "Active Machine" }).waitFor({ timeout: 60000 });

    await sidebarButton(page, "Home").click();
    await page.getByRole("button", { name: "New Thread" }).click();

    await page.getByTestId("webchat-input").fill("Reply with exactly: ACK");
    await page.getByTestId("webchat-send").click();

    await page.getByTestId("webchat-message-user").last().waitFor({ timeout: 15000 });

    await expect
      .poll(() => page.getByTestId("webchat-message-assistant").count(), { timeout: 120000 })
      .toBeGreaterThan(0);

    await expect
      .poll(
        async () => {
          const assistantText = await page
            .getByTestId("webchat-message-assistant")
            .last()
            .innerText();
          return assistantText.trim().length;
        },
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
  });
});
