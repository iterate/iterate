import { login, sidebarButton, test, createOrganization } from "./test-helpers.ts";

test.describe("jonasland projects", () => {
  test("creating a jonasland project uses the jonasland route tree", async ({ page }) => {
    const uniqueId = Date.now();
    const orgName = `jonasland org ${uniqueId}`;
    const projectName = `jonasland project ${uniqueId}`;

    await login(page, `jonas-land-${uniqueId}+test@nustom.com`);
    await createOrganization(page, orgName);

    await sidebarButton(page, /^(Create|New) project$/).click();
    await page.getByLabel("Project name").fill(projectName);
    await page.getByLabel("jonasland").click();
    await page.getByRole("button", { name: "Create project" }).click();

    await page.waitForURL(/\/jonasland\/[^/]+$/);
    await page.locator('[data-component="JonasLandProjectHomePage"]').first().waitFor();

    const projectSlug = page.url().split("/").at(-1) ?? "";

    await page.goto(`/proj/${projectSlug}`);
    await page.locator('[data-component="JonasLandProjectHomePage"]').first().waitFor();
  });

  test("jonasland deployments can be created and driven through the durable object lifecycle", async ({
    page,
  }) => {
    const uniqueId = Date.now();
    const orgName = `jonasland deploy org ${uniqueId}`;
    const projectName = `jonasland deploy project ${uniqueId}`;
    const deploymentName = `deployment ${uniqueId}`;

    await login(page, `jonas-land-deploy-${uniqueId}+test@nustom.com`);
    await createOrganization(page, orgName);

    await sidebarButton(page, /^(Create|New) project$/).click();
    await page.getByLabel("Project name").fill(projectName);
    await page.getByLabel("jonasland").click();
    await page.getByRole("button", { name: "Create project" }).click();

    await page.locator('[data-component="JonasLandProjectHomePage"]').waitFor();
    await sidebarButton(page, "Deployments").click();
    await page.locator('[data-component="JonasLandDeploymentsPage"]').waitFor();
    await page.locator('[data-transport="durable-iterator"]').waitFor();

    await page.getByRole("button", { name: "New deployment" }).click();
    await page.getByLabel("Deployment name").fill(deploymentName);
    await page.getByRole("button", { name: "Create deployment" }).click();

    const deploymentCard = page.locator("[data-deployment-id]").first();
    await deploymentCard.waitFor();
    await deploymentCard.locator('[data-deployment-state="created"]').waitFor();

    await deploymentCard.getByRole("button", { name: "Start" }).click();
    await deploymentCard.locator('[data-deployment-state="running"]').waitFor();

    await deploymentCard.getByRole("button", { name: "Stop" }).click();
    await deploymentCard.locator('[data-deployment-state="stopped"]').waitFor();

    await deploymentCard.getByRole("button", { name: "Destroy" }).click();
    await deploymentCard.locator('[data-deployment-state="destroyed"]').waitFor();
  });
});
