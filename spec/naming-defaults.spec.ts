import { login, test, createOrganization, createProject, sidebarButton } from "./test-helpers.ts";

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

    await page.waitForURL(`**/orgs/${uniqueName.toLowerCase()}/**`);
  });

  test("organization slug gets suffix on conflict", async ({ page, context }) => {
    const sharedName = `conflict-org-${Date.now()}`;

    const testEmail1 = `naming1-${Date.now()}+test@nustom.com`;
    await login(page, testEmail1);
    await createOrganization(page, sharedName);
    await page.waitForURL(`**/orgs/${sharedName.toLowerCase()}/**`);

    const page2 = await context.newPage();
    const testEmail2 = `naming2-${Date.now()}+test@nustom.com`;
    await login(page2, testEmail2);
    await createOrganization(page2, sharedName);
    await page2.waitForURL(/\/orgs\/conflict-org-\d+-[a-z0-9]{6}\//);
  });

  test("project slug has no suffix when unique within org", async ({ page }) => {
    const uniqueProjectName = `unique-project-${Date.now()}`;
    const testEmail = `naming-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page, uniqueProjectName);

    const projectLink = page.locator("[data-slot='item']", { hasText: uniqueProjectName });
    await projectLink.click();

    await page.waitForURL(`**/projects/${uniqueProjectName.toLowerCase()}/**`);
  });

  test("project slug gets suffix on conflict within same org", async ({ page }) => {
    const sharedProjectName = `conflict-project-${Date.now()}`;
    const testEmail = `naming-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);

    await createProject(page, sharedProjectName);
    const firstProjectLink = page.locator("[data-slot='item']", { hasText: sharedProjectName });
    await firstProjectLink.click();
    await page.waitForURL(`**/projects/${sharedProjectName.toLowerCase()}/**`);

    await createProject(page, sharedProjectName);
    const secondProjectLink = page
      .locator("[data-slot='item']", { hasText: sharedProjectName })
      .last();
    await secondProjectLink.click();
    await page.waitForURL(/\/projects\/conflict-project-\d+-[a-z0-9]{6}\//);
  });

  test("machine name defaults to type and timestamp", async ({ page }) => {
    const testEmail = `naming-${Date.now()}+test@nustom.com`;
    await login(page, testEmail);
    await createOrganization(page);
    const projectItem = await createProject(page);
    await projectItem.click();
    await sidebarButton(page, "Machines").click();

    await page.getByRole("button", { name: "Create Machine" }).click();

    await page
      .locator("input[placeholder='Machine name']")
      .and(page.locator("[value^='daytona-']"))
      .waitFor();
  });
});
