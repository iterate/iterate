import {
  login,
  createOrganization,
  createProject,
  getProjectBasePath,
  getOrganizationSlug,
  test,
} from "./test-helpers.ts";

test.describe("shell navigation", () => {
  test("connectors and team pages render", async ({ page }) => {
    const testEmail = `nav-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);

    await createOrganization(page);
    await createProject(page);

    const basePath = getProjectBasePath(page);

    await page.goto(`${basePath}/connectors`);
    await page.getByText("Project connections").waitFor();
    await page.getByText("Your connections").waitFor();

    const orgSlug = getOrganizationSlug(basePath);
    await page.goto(`/orgs/${orgSlug}/team`);
    await page.getByLabel("Email").waitFor();
  });

  test("user settings page is reachable", async ({ page }) => {
    const testEmail = `settings-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    await page.goto("/user/settings");
    await page.getByLabel("Name").waitFor();
  });
});
