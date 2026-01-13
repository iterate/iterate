import { login, test, createOrganization, createProject, sidebarButton } from "./test-helpers.ts";

test.describe("machine list sync", () => {
  test("shows new machine", async ({ page }) => {
    const testEmail = `machine-sync-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    const projectItem = await createProject(page);
    await projectItem.click();
    await sidebarButton(page, "Machines").click();

    const machineName = `E2E Machine ${Date.now()}`;
    await page.getByRole("button", { name: "Create Machine" }).click();
    await page.getByPlaceholder("Machine name").fill(machineName);
    await page.getByRole("button", { name: "Create" }).click();

    await page.getByText(machineName).waitFor();
  });
});
