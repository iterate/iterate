import { chromium, type Page, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

const BASE_URL = process.env.VITE_PUBLIC_URL || "http://localhost:5173";
const TEST_OTP = "424242";

async function login(page: Page, email: string) {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForSelector('input[type="email"]');
  await page.fill('input[type="email"]', email);
  await page.click('button:has-text("Continue with Email")');

  await page.waitForSelector('text="Enter verification code"', { timeout: 10000 });
  const otpInputs = page.locator('input[inputmode="numeric"]');
  await otpInputs.first().click();
  for (const char of TEST_OTP) {
    await page.keyboard.type(char);
  }
  await page.click('button:has-text("Verify")');

  await page.waitForURL((url) => !url.pathname.includes("/login"), {
    timeout: 15000,
  });
}

async function ensureOrganization(page: Page) {
  if (!page.url().includes("/new-organization")) {
    return;
  }

  await page.waitForSelector('input[placeholder="Organization name"]');
  const orgName = `E2E Org ${Date.now()}`;
  await page.fill('input[placeholder="Organization name"]', orgName);
  await page.click('button:has-text("Create organization")');

  await page.waitForURL(
    (url) =>
      !url.pathname.includes("/new-organization") && !url.pathname.includes("/login"),
    { timeout: 30000 },
  );
}

describe("machine list sync", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    await context?.close();
  });

  test("shows new machine without reload", async () => {
    const testEmail = `machine-sync-${Date.now()}+test@example.com`;
    await login(page, testEmail);
    await ensureOrganization(page);

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
