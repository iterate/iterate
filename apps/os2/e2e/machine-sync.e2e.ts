import { test, expect, type Page } from "@playwright/test";
import { login, ensureOrganization, ensureProject } from "./test-helpers.ts";

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
    await login(page, testEmail, baseURL);
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
