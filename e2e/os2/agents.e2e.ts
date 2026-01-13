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
    await page.getByRole("heading", { name: "Agents" }).waitFor();
    await page.getByText("Manage all iterate-managed coding agents").waitFor();
  });

  test("sidebar shows Agents section", async ({ page }) => {
    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.locator('[data-sidebar="group-label"]').getByText("Agents").waitFor();
  });

  test("can navigate to create agent page", async ({ page }) => {
    const newAgentLink = page.getByRole("main").getByRole("link", { name: "New Agent" });
    await newAgentLink.click();

    await page.waitForURL((url) => url.pathname.includes("/agents/new"));
    await page.getByRole("heading", { name: "New Agent" }).waitFor();
    await page.getByLabel("Name").waitFor();
    await page.getByLabel("Agent Type").waitFor();
    await page.getByLabel("Working Directory").waitFor();
  });

  test("can create a new agent", async ({ page }) => {
    const slug = uniqueSlug("test-agent");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await page.waitForURL((url) => url.pathname.includes("/agents/new"));

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });
  });

  test("agent appears in table after creation", async ({ page }) => {
    const slug = uniqueSlug("table-test");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });

    await page.goto("/agents");
    await page.getByRole("cell", { name: slug }).waitFor();
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
  });

  test("agent page loads after creation", async ({ page }) => {
    const slug = uniqueSlug("terminal-test");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });
  });

  test("header shows action buttons on agent page", async ({ page }) => {
    const slug = uniqueSlug("header-buttons");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });

    await page.getByRole("button", { name: "Reset" }).waitFor();
    await page.getByRole("button", { name: "Stop" }).waitFor();
    await page.getByRole("button", { name: "Delete" }).waitFor();
  });

  test("can archive an agent from table", async ({ page }) => {
    const slug = uniqueSlug("delete-me");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });
    await page.goto("/agents");
    await page.getByRole("cell", { name: slug }).waitFor();

    const row = page.getByRole("row", { name: new RegExp(slug) });
    await row.getByRole("button").last().click();

    await page.waitForTimeout(500);
    await page.getByRole("cell", { name: slug }).waitFor({ state: "hidden", timeout: 3000 });
  });

  test("breadcrumbs show agent slug", async ({ page }) => {
    const slug = uniqueSlug("breadcrumb");

    await page.getByRole("main").getByRole("link", { name: "New Agent" }).click();
    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.waitForURL((url) => url.pathname.includes(`/agents/${slug}`), { timeout: 10000 });

    const header = page.locator("header");
    await header.getByText(slug).waitFor();
  });
});
