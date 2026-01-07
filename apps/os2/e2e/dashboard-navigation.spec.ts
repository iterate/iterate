import { test, expect } from "@playwright/test";

test.describe("Dashboard sidebar navigation", () => {
  test("can navigate between pages using sidebar after creating org and project", async ({
    page,
  }) => {
    const testId = Date.now();
    const email = `test${testId}+test@nustom.com`;

    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Email" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send OTP" }).click();
    await page.getByLabel(/Enter OTP/i).fill("424242");
    await page.getByRole("button", { name: "Verify OTP" }).click();

    await expect(page.getByRole("textbox", { name: "Organization name" })).toBeVisible();
    await page.getByRole("textbox", { name: "Organization name" }).fill("Nav Test Org");
    await page.getByRole("button", { name: "Create Organization" }).click();

    await page.getByRole("button", { name: "Create Project" }).click();
    await page.getByRole("textbox", { name: "Project name" }).fill("Nav Project");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByText("No Machines")).toBeVisible();

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toBeVisible();

    await expect(sidebar.getByText("Nav Test Org")).toBeVisible();
    await expect(sidebar.getByText("Nav Project").first()).toBeVisible();

    await sidebar.getByRole("link", { name: "Team" }).click();
    await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();
    const main = page.locator("main").last();
    await expect(main.getByText(email)).toBeVisible();

    await sidebar.getByRole("link", { name: "Connectors" }).click();
    await expect(page.getByRole("heading", { name: "Connectors", exact: true })).toBeVisible();
    await expect(page.getByText("Slack", { exact: true })).toBeVisible();
    await expect(page.getByText("Google", { exact: true })).toBeVisible();

    await sidebar.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: /Settings/i })).toBeVisible();

    const orgSwitcher = sidebar.locator('[data-slot="sidebar-header"]').getByRole("button");
    await orgSwitcher.click();
    const dropdown = page.locator('[data-slot="dropdown-menu-content"]');
    await dropdown.getByText("Nav Project").click();

    await expect(sidebar.getByRole("link", { name: "Machines" })).toBeVisible();
    await sidebar.getByRole("link", { name: "Machines" }).click();
    await expect(page.getByText("No Machines")).toBeVisible();
  });

  test("org/project selector dropdown shows all organizations and projects", async ({ page }) => {
    const testId = Date.now();
    const email = `testselector${testId}+test@nustom.com`;

    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Email" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send OTP" }).click();
    await page.getByLabel(/Enter OTP/i).fill("424242");
    await page.getByRole("button", { name: "Verify OTP" }).click();

    await expect(page.getByRole("textbox", { name: "Organization name" })).toBeVisible();
    await page.getByRole("textbox", { name: "Organization name" }).fill("Selector Org");
    await page.getByRole("button", { name: "Create Organization" }).click();

    await page.getByRole("button", { name: "Create Project" }).click();
    await page.getByRole("textbox", { name: "Project name" }).fill("Project One");
    await page.getByRole("button", { name: "Create" }).click();

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toBeVisible();

    const orgSwitcher = sidebar.locator('[data-slot="sidebar-header"]').getByRole("button");
    await orgSwitcher.click();

    const dropdown = page.locator('[data-slot="dropdown-menu-content"]');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.getByText("Selector Org")).toBeVisible();
    await expect(dropdown.getByText("Project One")).toBeVisible();
    await expect(dropdown.getByText("Add organization")).toBeVisible();
  });

  test("account menu shows logout option", async ({ page }) => {
    const testId = Date.now();
    const email = `testaccount${testId}+test@nustom.com`;

    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Email" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send OTP" }).click();
    await page.getByLabel(/Enter OTP/i).fill("424242");
    await page.getByRole("button", { name: "Verify OTP" }).click();

    await expect(page.getByRole("textbox", { name: "Organization name" })).toBeVisible();
    await page.getByRole("textbox", { name: "Organization name" }).fill("Account Org");
    await page.getByRole("button", { name: "Create Organization" }).click();

    await page.getByRole("button", { name: "Create Project" }).click();
    await page.getByRole("textbox", { name: "Project name" }).fill("Account Project");
    await page.getByRole("button", { name: "Create" }).click();

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toBeVisible();

    const accountButton = sidebar.locator('[data-slot="sidebar-footer"]').getByRole("button");
    await expect(accountButton).toContainText(email);

    await accountButton.click();

    const dropdown = page.locator('[data-slot="dropdown-menu-content"]');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.getByText("Log out")).toBeVisible();

    await dropdown.getByText("Log out").click();

    await expect(page).toHaveURL(/\/login/);
  });
});
