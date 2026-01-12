import { expect } from "@playwright/test";
import { test } from "./test-helpers.ts";

function uniqueSlug(base: string): string {
  return `${base}-${Date.now()}`;
}

test.describe("agent management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("homepage shows welcome message", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "iterate daemon" })).toBeVisible();
    await expect(page.getByText("Select an agent from the sidebar")).toBeVisible();
  });

  test("sidebar shows Agents section", async ({ page }) => {
    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar.getByText("Agents")).toBeVisible();
  });

  test("can open create agent dialog", async ({ page }) => {
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "New Agent" })).toBeVisible();
    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("Agent Type")).toBeVisible();
    await expect(page.getByLabel("Working Directory")).toBeVisible();
  });

  test("can create a new agent", async ({ page }) => {
    const slug = uniqueSlug("test-agent");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });
    await expect(page.url()).toContain(`/agents/${slug}`);
  });

  test("agent appears in sidebar after creation", async ({ page }) => {
    const slug = uniqueSlug("sidebar-test");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar.getByText(slug)).toBeVisible();
  });

  test("can navigate to agent page from sidebar", async ({ page }) => {
    const slug = uniqueSlug("nav-test");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });

    await page.goto("/");

    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.getByText(slug).click();

    await expect(page.url()).toContain(`/agents/${slug}`);
  });

  test("agent page loads after creation", async ({ page }) => {
    const slug = uniqueSlug("terminal-test");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });
    await expect(page.url()).toContain(`/agents/${slug}`);

    await page.waitForTimeout(1000);

    expect(page.url()).toContain(`/agents/${slug}`);
  });

  test("header shows reset and stop buttons on agent page", async ({ page }) => {
    const slug = uniqueSlug("header-buttons");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });

    await expect(page.getByRole("button", { name: "Reset Agent" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop Agent" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete Agent" })).toBeVisible();
  });

  test("can delete an agent", async ({ page }) => {
    const slug = uniqueSlug("delete-me");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });

    const deleteButton = page.getByRole("button", { name: "Delete Agent" });
    await deleteButton.click();

    await page.waitForTimeout(500);

    await page.goto("/");

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar.getByText(slug)).not.toBeVisible({ timeout: 3000 });
  });

  test("breadcrumbs show agent slug", async ({ page }) => {
    const slug = uniqueSlug("breadcrumb");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });

    const header = page.locator("header");
    await expect(header.getByText(slug)).toBeVisible();
  });
});
