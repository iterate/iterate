import { test, expect } from "@playwright/test";
import {
  login,
  ensureOrganization,
  ensureProject,
  getProjectBasePath,
  getOrganizationSlug,
} from "./test-helpers.ts";

test.describe("shell navigation", () => {
  test("connectors and team pages render", async ({ page }) => {
    const testEmail = `nav-${Date.now()}+test@example.com`;
    await login(page, testEmail);
    await ensureOrganization(page);
    await ensureProject(page);

    const basePath = getProjectBasePath(page);

    await page.goto(`${basePath}/connectors`);
    await page.waitForSelector('text="Project connections"');
    await page.waitForSelector('text="Your connections"');
    await expect(page.locator('text="Project connections"')).toBeVisible();
    await expect(page.locator('text="Your connections"')).toBeVisible();

    const orgSlug = getOrganizationSlug(basePath);
    await page.goto(`/orgs/${orgSlug}/team`);
    await page.waitForSelector('input[id="member-email"]');
    await expect(page.locator('input[id="member-email"]')).toBeVisible();
  });

  test("user settings page is reachable", async ({ page }) => {
    const testEmail = `settings-${Date.now()}+test@example.com`;
    await login(page, testEmail);
    await ensureOrganization(page);
    await ensureProject(page);

    await page.goto("/user/settings");
    await page.waitForSelector('input[id="user-name"]');
    await expect(page.locator('input[id="user-name"]')).toBeVisible();
  });
});
