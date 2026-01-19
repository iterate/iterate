import { login, test, createOrganization, createProject, sidebarButton } from "./test-helpers.ts";

test.describe("local machine ready status", () => {
  test("local host/port machine becomes ready immediately", async ({ page }) => {
    const testEmail = `local-machine-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);
    await sidebarButton(page, "Machines").click();

    const machineName = `Local Machine ${Date.now()}`;
    await page.getByRole("link", { name: "Create Machine" }).click();

    // Select "Local (Host:Port)" type
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Local (Host:Port)" }).click();

    await page.getByPlaceholder("Machine name").fill(machineName);

    // Use default host and ports (localhost:3000)
    await page.getByRole("button", { name: "Create" }).click();

    // Machine should appear
    await page.getByText(machineName).waitFor();

    // Machine should show "Ready" status (not stuck on "Starting...")
    // The local machine should immediately be marked as ready since it doesn't need a daemon bootstrap
    await page.getByText("Ready").waitFor({ timeout: 5000 });
  });
});
