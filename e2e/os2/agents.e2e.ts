import { expect } from "@playwright/test";
import { test } from "../test-helpers.ts";

function uniqueSlug(base: string): string {
  return `${base}-${Date.now()}`;
}

test.describe("agent management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("agents page shows heading", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await expect(page.getByText("Manage all iterate-managed coding agents")).toBeVisible();
  });

  test("sidebar shows Agents section", async ({ page }) => {
    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar.locator('[data-sidebar="group-label"]').getByText("Agents")).toBeVisible();
  });

  test("can navigate to create agent page", async ({ page }) => {
    const newAgentLink = page.getByRole("main").getByRole("link", { name: "New Agent" });
    await newAgentLink.click();

    await expect(page.url()).toContain("/agents/new");
    await expect(page.getByRole("heading", { name: "New Agent" })).toBeVisible();
    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("Agent Type")).toBeVisible();
    await expect(page.getByLabel("Working Directory")).toBeVisible();
  });

  test("can create a new agent", async ({ page }) => {
    const slug = uniqueSlug("test-agent");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await expect(page.url()).toContain("/agents/new");

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });
    await expect(page.url()).toContain(`/agents/${slug}`);
  });

  test("agent appears in table after creation", async ({ page }) => {
    const slug = uniqueSlug("table-test");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });

    await page.goto("/agents");
    await expect(page.getByRole("cell", { name: slug })).toBeVisible();
  });

  test("can navigate to agent page from table", async ({ page }) => {
    const slug = uniqueSlug("nav-test");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });

    await page.goto("/agents");
    await page.getByRole("row", { name: new RegExp(slug) }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 5000 });
    await expect(page.url()).toContain(`/agents/${slug}`);
  });

  test("agent page loads after creation", async ({ page }) => {
    const slug = uniqueSlug("terminal-test");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });
    expect(page.url()).toContain(`/agents/${slug}`);
  });

  test("header shows action buttons on agent page", async ({ page }) => {
    const slug = uniqueSlug("header-buttons");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });
    await expect(page.url()).toContain(`/agents/${slug}`);

    await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  });

  test("can archive an agent from table", async ({ page }) => {
    const slug = uniqueSlug("delete-me");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });
    await page.goto("/agents");
    await expect(page.getByRole("cell", { name: slug })).toBeVisible();

    const row = page.getByRole("row", { name: new RegExp(slug) });
    await row.getByRole("button").last().click();

    await page.waitForTimeout(500);
    await expect(page.getByRole("cell", { name: slug })).not.toBeVisible({ timeout: 3000 });
  });

  test("breadcrumbs show agent slug", async ({ page }) => {
    const slug = uniqueSlug("breadcrumb");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });
    await expect(page.url()).toContain(`/agents/${slug}`);

    const header = page.locator("header");
    await expect(header.getByText(slug)).toBeVisible();
  });
});
