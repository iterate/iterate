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

export async function login(page: Page, email: string) {
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

  await ensureSidebarOpen(page);
  await page.locator("[data-component='OrgSwitcher']", { hasText: orgName }).waitFor();
  await closeSidebar(page);
}

export async function createProject(page: Page, projectName = `E2E Project ${Date.now()}`) {
  await page.getByText("Create project").click();
  await page.getByLabel("Project name").fill(projectName);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/projects\//);
  await ensureSidebarOpen(page);
  await page.locator("[data-sidebar='group-label']").getByText("Project:").waitFor();
  await closeSidebar(page);
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

const openSidebarParentSelector = `[data-slot='sidebar'][data-state='open']`;
const triggerOpenButtonSelector = `main:not(:has(${openSidebarParentSelector})) [data-slot='sidebar-trigger']`;
const alreadyOpenNoopSelector = `${openSidebarParentSelector} [data-sidebar='group-label']`;

export async function ensureSidebarOpen(page: Page) {
  await page.locator(`${triggerOpenButtonSelector}, ${alreadyOpenNoopSelector}`).click();
}

export async function closeSidebar(page: Page) {
  await page.keyboard.press("Escape"); // close the sidebar if it's closeable
}

export async function sidebarClick(page: Page, text: string) {
  await ensureSidebarOpen(page);
  await sidebarButton(page, text).click();
  await page.keyboard.press("Escape"); // close the sidebar if it's closeable
}

export function sidebarButton(page: Page, text: string) {
  return page.locator("[data-slot='sidebar']").getByText(text, { exact: true });
}
