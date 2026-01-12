import { test } from "./test-helpers.ts";

function uniqueSlug(base: string): string {
  return `${base}-${Date.now()}`;
}

test.skip("agent management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByRole("heading", { name: "iterate daemon" }).waitFor();
  });

  test("homepage shows welcome message", async ({ page }) => {
    await page.getByRole("heading", { name: "iterate daemon" }).waitFor();
    await page.getByText("Select an agent from the sidebar").waitFor();
  });

  test("sidebar shows Agents section", async ({ page }) => {
    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.getByText("Agents").waitFor();
  });

  test("can open create agent dialog", async ({ page }) => {
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByRole("dialog").waitFor();
    await page.getByRole("heading", { name: "New Agent" }).waitFor();
    await page.getByLabel("Name").waitFor();
    await page.getByLabel("Agent Type").waitFor();
    await page.getByLabel("Working Directory").waitFor();
  });

  test("can create a new agent", async ({ page }) => {
    const slug = uniqueSlug("test-agent");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.locator("header").getByText(slug).waitFor();
  });

  test("agent appears in sidebar after creation", async ({ page }) => {
    const slug = uniqueSlug("sidebar-test");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.getByText(slug).waitFor();
  });

  test("can navigate to agent page from sidebar", async ({ page }) => {
    const slug = uniqueSlug("nav-test");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.locator("header").getByText(slug).waitFor();

    await page.goto("/");
    await page.getByRole("heading", { name: "iterate daemon" }).waitFor();

    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.getByText(slug).click();

    await page.locator("header").getByText(slug).waitFor();
  });

  test("agent page loads after creation", async ({ page }) => {
    const slug = uniqueSlug("terminal-test");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.locator("header").getByText(slug).waitFor();
  });

  test("header shows reset and stop buttons on agent page", async ({ page }) => {
    const slug = uniqueSlug("header-buttons");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.getByRole("button", { name: "Reset Agent" }).waitFor();
    await page.getByRole("button", { name: "Stop Agent" }).waitFor();
    await page.getByRole("button", { name: "Delete Agent" }).waitFor();
  });

  test("can delete an agent", async ({ page }) => {
    const slug = uniqueSlug("delete-me");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    await page.locator("header").getByText(slug).waitFor();

    const deleteButton = page.getByRole("button", { name: "Delete Agent" });
    await deleteButton.click();

    await page.getByRole("heading", { name: "iterate daemon" }).waitFor();

    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.getByText(slug).waitFor({ state: "hidden" });
  });

  test("breadcrumbs show agent slug", async ({ page }) => {
    const slug = uniqueSlug("breadcrumb");
    const newAgentButton = page.getByRole("button", { name: "New Agent" });
    await newAgentButton.click();

    await page.getByLabel("Name").fill(slug);
    await page.getByRole("button", { name: "Create Agent" }).click();

    const header = page.locator("header");
    await header.getByText(slug).waitFor();
  });
});
