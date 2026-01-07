import { test, expect, type Page } from "@playwright/test";

const TEST_OTP = "424242";

async function login(page: Page, email: string, baseURL: string) {
  await page.goto(`${baseURL}/login`);
  await page.waitForSelector('input[type="email"]');
  await page.fill('input[type="email"]', email);
  await page.click('button:has-text("Continue with Email")');

  await page.waitForSelector('text="Enter verification code"', { timeout: 10000 });
  const otpInputs = page.locator('input[inputmode="numeric"]');
  await otpInputs.first().click();
  for (const char of TEST_OTP) {
    await page.keyboard.type(char);
  }

  await page.waitForURL((url) => !url.pathname.includes("/login"), {
    timeout: 15000,
  });
}

async function ensureOrganization(page: Page) {
  if (!page.url().includes("/new-organization")) {
    return;
  }

  await page.waitForSelector('input[id="organization-name"]');
  const orgName = `E2E Org ${Date.now()}`;
  await page.fill('input[id="organization-name"]', orgName);
  await page.click('button:has-text("Create organization")');

  await page.waitForURL(
    (url) =>
      !url.pathname.includes("/new-organization") && !url.pathname.includes("/login"),
    { timeout: 30000 },
  );
}

async function ensureProject(page: Page) {
  if (!page.url().includes("/projects/new")) {
    return;
  }

  await page.waitForSelector('input[id="project-name"]');
  const projectName = `E2E Project ${Date.now()}`;
  await page.fill('input[id="project-name"]', projectName);
  await page.click('button:has-text("Create project")');
  await page.waitForURL((url) => !url.pathname.includes("/projects/new"), { timeout: 30000 });
}

async function goToMachinesPage(page: Page, baseURL: string) {
  const url = new URL(page.url());
  if (url.pathname.endsWith("/machines")) {
    return;
  }
  const basePath = url.pathname.replace(/\/$/, "");
  await page.goto(`${baseURL}${basePath}/machines`);
  await page.waitForURL((nextUrl) => nextUrl.pathname.endsWith("/machines"));
}

test.describe("machine list sync", () => {
  test("shows new machine without reload", async ({ page, baseURL }) => {
    const testEmail = `machine-sync-${Date.now()}+test@example.com`;
    await login(page, testEmail, baseURL!);
    await ensureOrganization(page);
    await ensureProject(page);
    await goToMachinesPage(page, baseURL!);

    await page.waitForSelector('button:has-text("New Machine")');

    const machineName = `E2E Machine ${Date.now()}`;
    await page.click('button:has-text("New Machine")');
    await page.waitForSelector('input[placeholder="Machine name"]');
    await page.fill('input[placeholder="Machine name"]', machineName);
    await page.click('button:has-text("Create")');

    await page.waitForSelector(`text="${machineName}"`, { timeout: 10000 });
    expect(await page.isVisible(`text="${machineName}"`)).toBe(true);
  });
});
