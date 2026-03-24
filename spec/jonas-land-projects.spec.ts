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
    const firstDeploymentName = `deployment ${uniqueId} a`;
    const secondDeploymentName = `deployment ${uniqueId} b`;

    await login(page, `jonas-land-deploy-${uniqueId}+test@nustom.com`);
    await createOrganization(page, orgName);

    await sidebarButton(page, /^(Create|New) project$/).click();
    await page.getByLabel("Project name").fill(projectName);
    await page.getByLabel("jonasland").click();
    await page.getByRole("button", { name: "Create project" }).click();

    await page.locator('[data-component="JonasLandProjectHomePage"]').first().waitFor();
    const projectSlug = page.url().split("/").at(-1) ?? "";

    await sidebarButton(page, "Deployments").click();
    await page.locator('[data-component="JonasLandDeploymentsPage"]').waitFor();

    await page.getByRole("button", { name: "New deployment" }).click();
    await page.getByLabel("Deployment name").fill(firstDeploymentName);
    await page.getByRole("button", { name: "Create deployment" }).click();

    const firstDeployment = page.locator(`[data-deployment-name="${firstDeploymentName}"]`);
    await firstDeployment.waitFor();
    await page
      .locator(`[data-deployment-name="${firstDeploymentName}"][data-primary="true"]`)
      .waitFor();
    await page
      .locator(`[data-deployment-name="${firstDeploymentName}"][data-deployment-state="running"]`)
      .waitFor();

    await page.getByRole("button", { name: "New deployment" }).click();
    await page.getByLabel("Deployment name").fill(secondDeploymentName);
    await page.getByRole("button", { name: "Create deployment" }).click();

    const secondDeployment = page.locator(`[data-deployment-name="${secondDeploymentName}"]`);
    await secondDeployment.waitFor();
    await page
      .locator(`[data-deployment-name="${secondDeploymentName}"][data-primary="true"]`)
      .waitFor();
    await page
      .locator(`[data-deployment-name="${firstDeploymentName}"][data-primary="false"]`)
      .waitFor();

    await firstDeployment.getByRole("button", { name: "Make primary" }).click();
    await page
      .locator(`[data-deployment-name="${firstDeploymentName}"][data-primary="true"]`)
      .waitFor();
    await firstDeployment.getByText(`${projectSlug}.jonasland.local`).waitFor();
    await page
      .locator(`[data-deployment-name="${secondDeploymentName}"][data-primary="false"]`)
      .waitFor();

    await firstDeployment.getByRole("link", { name: "Details" }).click();
    await page.locator('[data-component="JonasLandDeploymentDetailPage"]').waitFor();
    await page.locator("[data-log-line]").first().waitFor();

    await page.getByRole("button", { name: "Stop" }).click();
    await page.locator('[data-deployment-state="stopped"]').waitFor();
    await page
      .locator('[data-component="JonasLandDeploymentDetailPage"]')
      .getByText("Deployment stopped")
      .waitFor();

    await page.getByRole("button", { name: "Destroy" }).click();
    await page.locator('[data-deployment-state="destroyed"]').waitFor();
    await page
      .locator('[data-component="JonasLandDeploymentDetailPage"]')
      .getByText("Destroyed deployment resources")
      .waitFor();
  });

  test("jonasland can create a second deployment without hanging the UI", async ({ page }) => {
    const uniqueId = Date.now();
    const orgName = `jonasland second deploy org ${uniqueId}`;
    const projectName = `jonasland second deploy project ${uniqueId}`;
    const firstDeploymentName = `deployment ${uniqueId} one`;
    const secondDeploymentName = `deployment ${uniqueId} two`;

    await login(page, `jonas-land-second-deploy-${uniqueId}+test@nustom.com`);
    await createOrganization(page, orgName);

    await sidebarButton(page, /^(Create|New) project$/).click();
    await page.getByLabel("Project name").fill(projectName);
    await page.getByLabel("jonasland").click();
    await page.getByRole("button", { name: "Create project" }).click();

    await page.locator('[data-component="JonasLandProjectHomePage"]').first().waitFor();

    await sidebarButton(page, "Deployments").click();
    await page.locator('[data-component="JonasLandDeploymentsPage"]').waitFor();

    await page.getByRole("button", { name: "New deployment" }).click();
    await page.getByLabel("Deployment name").fill(firstDeploymentName);
    await page.getByRole("button", { name: "Create deployment" }).click();
    await page.locator(`[data-deployment-name="${firstDeploymentName}"]`).waitFor();

    await page.getByRole("button", { name: "New deployment" }).click();
    await page.getByLabel("Deployment name").fill(secondDeploymentName);
    await page.getByRole("button", { name: "Create deployment" }).click();
    await page.locator(`[data-deployment-name="${secondDeploymentName}"]`).waitFor();
    await page
      .locator(`[data-deployment-name="${secondDeploymentName}"][data-primary="true"]`)
      .waitFor();
  });
});
