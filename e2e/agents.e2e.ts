import { test as base } from "./test-helpers.ts";

const test = base.extend<{ baseURL: string }>({
  baseURL: async ({ baseURL }, use) => {
    const newURL = baseURL.includes("//localhost:5173") ? "http://localhost:3000" : baseURL;
    await use(newURL);
  },
});

function uniqueSlug(base: string): string {
  return `${base}-${Date.now()}`;
}

test.describe("agent management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByRole("heading", { name: "Agents" }).waitFor();
  });

  test("agents page shows heading and new agent button", async ({ page }) => {
    await page.getByRole("heading", { name: "Agents" }).waitFor();
    await page.getByRole("main").getByRole("link", { name: "New Agent" }).waitFor();
  });

  test("sidebar shows Agents label", async ({ page }) => {
    await page.locator('[data-sidebar="group-label"]').getByText("Agents").waitFor();
  });

  test("can open new agent page", async ({ page }) => {
    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();

    await page.getByRole("heading", { name: "New Agent" }).waitFor();
    await page.getByLabel("Name").waitFor();
    await page.getByLabel("Agent Type").waitFor();
    await page.getByLabel("Working Directory").waitFor();
  });

  test("can create a new agent", async ({ page }) => {
    const slug = uniqueSlug("test-agent");
    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.locator("header").getByText(slug).waitFor();
  });

  test("agent appears in sidebar after creation", async ({ page }) => {
    const slug = uniqueSlug("sidebar-test");
    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.getByText(slug).waitFor();
  });

  test("can navigate to agent page from sidebar", async ({ page }) => {
    const slug = uniqueSlug("nav-test");
    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.locator("header").getByText(slug).waitFor();

    await page.goto("/");
    await page.getByRole("heading", { name: "Agents" }).waitFor();

    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.getByText(slug).click();

    await page.locator("header").getByText(slug).waitFor();
  });

  test("agent page loads after creation", async ({ page }) => {
    const slug = uniqueSlug("terminal-test");
    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.locator("header").getByText(slug).waitFor();
  });

  test("header shows reset and stop buttons on agent page", async ({ page }) => {
    const slug = uniqueSlug("header-buttons");
    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.getByRole("button", { name: "Reset Agent" }).waitFor();
    await page.getByRole("button", { name: "Stop Agent" }).waitFor();
    await page.getByRole("button", { name: "Delete Agent" }).waitFor();
  });

  test("archive button appears on hover in sidebar", async ({ page }) => {
    const slug = uniqueSlug("hover-test");
    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    const sidebar = page.locator('[data-slot="sidebar"]');
    const agentItem = sidebar.getByRole("listitem").filter({ hasText: slug });
    await agentItem.waitFor();

    await agentItem.hover();
    await agentItem.getByRole("button", { name: "Archive agent" }).waitFor();
  });

  test("breadcrumbs show agent slug", async ({ page }) => {
    const slug = uniqueSlug("breadcrumb");
    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    const header = page.locator("header");
    await header.getByText(slug).waitFor();
  });
});
