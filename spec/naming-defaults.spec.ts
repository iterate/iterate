import {
  login,
  logout,
  test,
  createOrganization,
  createProject,
  sidebarButton,
  toast,
} from "./test-helpers.ts";

test.describe("naming defaults", () => {
  test("organization name defaults to email domain", async ({ page }) => {
    const testEmail = `naming-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);

    await page.getByLabel("Organization name").and(page.locator("[value='nustom.com']")).waitFor();
  });

  test("organization slug has no suffix when unique", async ({ page }) => {
    const uniqueName = `unique-org-${Date.now()}`;
    const testEmail = `naming-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page, uniqueName);

    await page.locator(`[data-organization="${uniqueName}"]`).waitFor();
  });

  test("duplicate organization name shows error", async ({ page }) => {
    const sharedName = `conflict-org-${Date.now()}`;

    const testEmail1 = `naming1-${Date.now()}+test@nustom.com`;
    await login(page, testEmail1);
    await createOrganization(page, sharedName);
    await page.locator(`[data-organization="${sharedName}"]`).waitFor();

    await logout(page);

    // Second user tries same name
    const testEmail2 = `naming2-${Date.now()}+test@nustom.com`;
    await login(page, testEmail2);
    await page.getByLabel("Organization name").fill(sharedName);
    await page.getByRole("button", { name: "Create organization" }).click();

    await toast.error(page, "organization with this name already exists").waitFor();
  });

  test("project slug has no suffix when unique within org", async ({ page }) => {
    const uniqueProjectName = `unique-project-${Date.now()}`;
    const testEmail = `naming-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page, uniqueProjectName);

    await page.locator(`[data-project="${uniqueProjectName.toLowerCase()}"]`).waitFor();
  });

  test("duplicate project name within same org shows error", async ({ page }) => {
    const sharedProjectName = `conflict-project-${Date.now()}`;
    const testEmail = `naming-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);

    await createProject(page, sharedProjectName);

    await page.locator("[data-group='organization']").getByText("Settings").click();
    await page.getByText("New project").click();
    await page.getByLabel("Project name").fill(sharedProjectName);
    await page.getByRole("button", { name: "Create project" }).click();

    await toast.error(page, "Failed to create project").waitFor();
  });

  test("machine name defaults to type and timestamp", async ({ page }) => {
    const testEmail = `naming-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);
    await sidebarButton(page, "Machines").click();

    await page.getByRole("link", { name: "Create Machine" }).click();

    await page
      .locator("input[placeholder='Machine name']")
      .and(page.locator("[value^='daytona-']"))
      .waitFor();
  });
});
