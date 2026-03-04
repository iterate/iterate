import { login, test, createOrganization, createProject, sidebarButton } from "./test-helpers.ts";

test.describe("project-level machine provider", () => {
  test("machine creation uses project provider and hides type selection", async ({ page }) => {
    const testEmail = `machine-provider-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);
    await sidebarButton(page, "Machines").click();

    await page.getByRole("link", { name: "Create Machine" }).click();

    await page.getByText("Provider is managed at project level.").waitFor();
    await page.getByText("Sandbox Provider").waitFor();
    await page.getByText(/^(fly|docker)$/).waitFor();
    await page.getByText(/^daytona$/).waitFor({ state: "hidden" });
  });
});
