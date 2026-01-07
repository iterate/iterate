import type { Page } from "@playwright/test";

const TEST_OTP = "424242";

export async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.waitForSelector('input[type="email"]');
  await page.fill('input[type="email"]', email);
  await page.click('button:has-text("Continue with Email")');

  await page.waitForSelector('text="Enter verification code"', { timeout: 10000 });
  const otpInputs = page.locator('input[inputmode="numeric"]');
  await otpInputs.first().click();
  for (const char of TEST_OTP) {
    await page.keyboard.type(char);
  }

  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
}

export async function ensureOrganization(page: Page) {
  if (!page.url().includes("/new-organization")) {
    return;
  }

  await page.waitForSelector('input[id="organization-name"]');
  const orgName = `E2E Org ${Date.now()}`;
  await page.fill('input[id="organization-name"]', orgName);
  await page.click('button:has-text("Create organization")');

  await page.waitForURL(
    (url) => !url.pathname.includes("/new-organization") && !url.pathname.includes("/login"),
    { timeout: 30000 },
  );
}

export async function ensureProject(page: Page) {
  if (!page.url().includes("/projects/new")) {
    return;
  }

  await page.waitForSelector('input[id="project-name"]');
  const projectName = `E2E Project ${Date.now()}`;
  await page.fill('input[id="project-name"]', projectName);
  await page.click('button:has-text("Create project")');
  await page.waitForURL((url) => !url.pathname.includes("/projects/new"), { timeout: 30000 });
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
