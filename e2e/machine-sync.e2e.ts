import { login, test, createOrganization, createProject, sidebarButton } from "./test-helpers.ts";

test.describe("machine list sync", () => {
  test("shows new machine", async ({ page, baseURL }) => {
    const testEmail = `machine-sync-${Date.now()}+test@nustom.com`;
    await login(page, testEmail, baseURL);
    await createOrganization(page);
    await createProject(page);
    await sidebarButton(page, "Machines").click();

    const machineName = `E2E Machine ${Date.now()}`;
    await page.getByRole("button", { name: "Create Machine" }).click();
    await page.getByPlaceholder("Machine name").fill(machineName);
    await page.getByRole("button", { name: "Create" }).click();

    await page.getByText(machineName).waitFor();
  });
});
