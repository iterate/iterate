import { test, expect } from "@playwright/test";
import {
  login,
  ensureOrganization,
  ensureProject,
  getProjectBasePath,
  getOrganizationSlug,
} from "./test-helpers.ts";

test.describe("shell navigation", () => {
  test("connectors and team pages render", async ({ page, baseURL }) => {
    const testEmail = `nav-${Date.now()}+test@example.com`;
    await login(page, testEmail, baseURL);
    await ensureOrganization(page);
    await ensureProject(page);

    const basePath = getProjectBasePath(page);

    await page.goto(`${baseURL}${basePath}/connectors`);
    await page.waitForSelector('text="Project connections"');
    await page.waitForSelector('text="Your connections"');
    expect(await page.isVisible('text="Project connections"')).toBe(true);
    expect(await page.isVisible('text="Your connections"')).toBe(true);

    const orgSlug = getOrganizationSlug(basePath);
    await page.goto(`${baseURL}/orgs/${orgSlug}/team`);
    await page.waitForSelector('input[id="member-email"]');
    expect(await page.isVisible('input[id="member-email"]')).toBe(true);
  });

  test("user settings page is reachable", async ({ page, baseURL }) => {
    const testEmail = `settings-${Date.now()}+test@example.com`;
    await login(page, testEmail, baseURL);
    await ensureOrganization(page);
    await ensureProject(page);

    await page.goto(`${baseURL}/user/settings`);
    await page.waitForSelector('input[id="user-name"]');
    expect(await page.isVisible('input[id="user-name"]')).toBe(true);
  });
});
