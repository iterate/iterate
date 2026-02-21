import * as path from "node:path";
import { type Page, test as base } from "@playwright/test"; // eslint-disable-line no-restricted-imports -- ok here
import { addPlugins } from "./playwright-plugin.ts";
import { hydrationWaiter, spinnerWaiter, videoMode, toastErrorReporter } from "./plugins/index.ts";

const TEST_OTP = "424242";

export const baseTest = base;

export const test = base.extend({
  page: async ({ page: basePage }, use, testInfo) => {
    await using page = await addPlugins({
      page: basePage,
      testInfo,
      plugins: [
        hydrationWaiter(),
        spinnerWaiter(),
        toastErrorReporter(),
        !!process.env.VIDEO_MODE && videoMode(),
      ],
      boxedStackPrefixes: (defaults) => [
        ...defaults,
        path.join(import.meta.dirname, "plugins"), // don't show plugin source files in stack traces
      ],
    });

    await use(page);
  },
});

export async function login(page: Page, email: string) {
  await page.goto("/login");

  const emailInput = page.getByTestId("email-input");
  await emailInput.waitFor();
  // Wait for hydration to complete - input is disabled until then
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
    .filter({ hasText: /Welcome to Iterate|Create organization|Dashboard|Projects/ })
    .first()
    .waitFor();
}

export async function createOrganization(page: Page, orgName = `E2E Org ${Date.now()}`) {
  await page.getByLabel("Organization name").fill(orgName);
  await page.getByRole("button", { name: "Create organization" }).click();

  // make sure the org switcher eventually shows up
  await page.locator("[data-component='OrgSwitcher']", { hasText: orgName }).waitFor();
}

export async function createProject(page: Page, projectName = `E2E Project ${Date.now()}`) {
  await sidebarButton(page, /^(Create|New) project$/).click();
  await page.getByLabel("Project name").fill(projectName);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.locator(`[data-project]`).waitFor();
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

export function sidebarButton(page: Page, text: string | RegExp) {
  return page.locator("[data-slot='sidebar']").getByText(text, { exact: true });
}

export async function logout(page: Page) {
  await page.locator(`[data-slot="sidebar-footer"] button`).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.getByTestId("email-input").waitFor();
}

function toastLocator(page: Page, type: "error" | "success", text?: string | RegExp) {
  return page.locator(`[data-sonner-toast][data-type="${type}"]`, { hasText: text || "" });
}

export const toast = {
  error: (page: Page, text?: string | RegExp) => toastLocator(page, "error", text),
  success: (page: Page, text?: string | RegExp) => toastLocator(page, "success", text),
};
