// eslint-disable-next-line no-restricted-imports -- this is the place that we wrap it
import { type Page, test as base } from "@playwright/test";
import { spinnerWaiter } from "./spinner-waiter.ts";

const TEST_OTP = "424242";

export type TestInputs = {
  spinnerWaiter: typeof spinnerWaiter;
};
export const test = base.extend<TestInputs>({
  page: async ({ page }, use) => {
    spinnerWaiter.setup(page);
    await use(page);
  },
  spinnerWaiter,
});

export async function login(page: Page, email: string, _baseURL?: string) {
  await page.goto("/login");

  const emailInput = page.getByTestId("email-input");
  await emailInput.waitFor();
  await emailInput.fill(email);

  const submitButton = page.getByTestId("email-submit-button");
  await submitButton.waitFor();
  await submitButton.click();

  await page.getByText("Enter verification code").waitFor();

  const firstOtpInput = page.locator('input[inputmode="numeric"]').first();
  await firstOtpInput.focus();
  await page.keyboard.type(TEST_OTP);

  await page
    .locator("h1")
    .filter({ hasText: /Create organization|Dashboard|Projects/ })
    .first()
    .waitFor();
}

export async function createOrganization(page: Page, orgName = `E2E Org ${Date.now()}`) {
  await page.getByLabel("Organization name").fill(orgName);
  await page.getByRole("button", { name: "Create organization" }).click();

  // make sure the org switcher eventually shows up
  await page
    .locator("[data-component='OrgSwitcher']", { hasText: orgName })
    .waitFor({ timeout: 10000 });
}

export async function createProject(page: Page, projectName = `E2E Project ${Date.now()}`) {
  // Look for either "New project" link or "Create project" link (empty state)
  const newProjectLink = page.getByRole("link", { name: "New project" });
  const createProjectLink = page.getByRole("link", { name: "Create project" });

  await newProjectLink.or(createProjectLink).first().waitFor({ timeout: 10000 });
  await newProjectLink.or(createProjectLink).first().click();

  await page.getByLabel("Project name").fill(projectName);
  await page.getByRole("button", { name: "Create project" }).click();

  // Wait for the project to appear in the sidebar, then click to navigate to it
  const projectLink = page
    .locator("[data-slot='sidebar']")
    .getByRole("link", { name: projectName });
  await projectLink.waitFor({ timeout: 10000 });
  await projectLink.click();

  // Wait for the project page to load
  await page
    .locator("[data-component='ProjectHomePage']", { hasText: projectName })
    .waitFor({ timeout: 10000 });
}

export async function ensureOrganization(page: Page, orgName = `E2E Org ${Date.now()}`) {
  // After login, check if we're at the create organization page
  const createOrgHeading = page.locator("h1").filter({ hasText: "Create organization" });
  if (await createOrgHeading.isVisible({ timeout: 1000 }).catch(() => false)) {
    await createOrganization(page, orgName);
  }
}

export async function ensureProject(page: Page, projectName = `E2E Project ${Date.now()}`) {
  // Check if we need to create a project (no projects exist yet)
  const addProjectButton = page.getByText("Add project");
  const projectHomePage = page.locator("[data-component='ProjectHomePage']");

  // If we're not on a project page, create one
  if (await addProjectButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    if (!(await projectHomePage.isVisible({ timeout: 500 }).catch(() => false))) {
      await createProject(page, projectName);
    }
  }
}

export function getProjectBasePath(page: Page) {
  const url = new URL(page.url());
  return url.pathname.replace(/\/$/, "");
}

export function getOrganizationSlug(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  const orgIndex = parts.indexOf("orgs");
  return orgIndex >= 0 ? parts[orgIndex + 1] : "";
}

export function sidebarButton(page: Page, text: string) {
  return page.locator("[data-slot='sidebar']").getByText(text, { exact: true });
}
