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

  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
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
    (url) => !url.pathname.includes("/new-organization") && !url.pathname.includes("/login"),
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

function getProjectBasePath(page: Page) {
  const url = new URL(page.url());
  const basePath = url.pathname.replace(/\/$/, "");
  return basePath;
}

function getOrganizationSlug(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  const orgIndex = parts.indexOf("orgs");
  return orgIndex >= 0 ? parts[orgIndex + 1] : "";
}

describe("shell navigation", () => {
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

  test("connectors and team pages render", async () => {
    const testEmail = `nav-${Date.now()}+test@example.com`;
    await login(page, testEmail);
    await ensureOrganization(page);
    await ensureProject(page);

    const basePath = getProjectBasePath(page);

    await page.goto(`${BASE_URL}${basePath}/connectors`);
    await page.waitForSelector('text="Project connections"');
    await page.waitForSelector('text="Your connections"');
    expect(await page.isVisible('text="Project connections"')).toBe(true);
    expect(await page.isVisible('text="Your connections"')).toBe(true);

    const orgSlug = getOrganizationSlug(basePath);
    await page.goto(`${BASE_URL}/orgs/${orgSlug}/team`);
    await page.waitForSelector('input[id="member-email"]');
    expect(await page.isVisible('input[id="member-email"]')).toBe(true);
  });

  test("user settings page is reachable", async () => {
    const testEmail = `settings-${Date.now()}+test@example.com`;
    await login(page, testEmail);
    await ensureOrganization(page);
    await ensureProject(page);

    await page.goto(`${BASE_URL}/user/settings`);
    await page.waitForSelector('input[id="user-name"]');
    expect(await page.isVisible('input[id="user-name"]')).toBe(true);
  });
});
