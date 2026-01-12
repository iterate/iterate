import { expect } from "@playwright/test";
import { login, ensureOrganization, ensureProject, test } from "./test-helpers.ts";

test.describe("admin impersonation", () => {
  test("admin can impersonate another user and stop impersonating", async ({ page, baseURL }) => {
    const timestamp = Date.now();
    const adminEmail = `admin-${timestamp}+test@nustom.com`;
    const targetEmail = `target-${timestamp}+test@nustom.com`;

    // Create admin user via testing API
    const createAdminResponse = await fetch(`${baseURL}/api/trpc/testing.createTestUser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: adminEmail,
        name: "Test Admin",
        role: "admin",
      }),
    });
    expect(createAdminResponse.ok).toBe(true);

    // Create target user via testing API
    const createTargetResponse = await fetch(`${baseURL}/api/trpc/testing.createTestUser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: targetEmail,
        name: "Target User",
        role: "user",
      }),
    });
    expect(createTargetResponse.ok).toBe(true);

    // Login as admin
    await login(page, adminEmail, baseURL);
    await ensureOrganization(page);
    await ensureProject(page);

    // Wait for the page to fully load
    await page.waitForLoadState("networkidle");

    // Open the user dropdown in the sidebar footer
    const userDropdownTrigger = page.locator('[data-slot="sidebar-menu-button"]').last();
    await expect(userDropdownTrigger).toBeVisible({ timeout: 10000 });
    await userDropdownTrigger.click();

    // Check that "Impersonate another user" option is visible (admin only)
    const impersonateOption = page.getByText("Impersonate another user");
    await expect(impersonateOption).toBeVisible({ timeout: 5000 });
    await impersonateOption.click();

    // Wait for the impersonation dialog to open
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Verify dialog title
    await expect(dialog.getByText("Impersonate another user")).toBeVisible();

    // The default type should be "By Email" - type the target user's email
    const emailInput = dialog.locator('input[placeholder="user@example.com"]');
    await expect(emailInput).toBeVisible();
    await emailInput.fill(targetEmail);

    // Wait for search results to appear
    await page.waitForTimeout(1000); // Wait for debounce

    // Click on the target user in the search results
    const targetUserResult = dialog.getByText(targetEmail);
    await expect(targetUserResult).toBeVisible({ timeout: 10000 });
    await targetUserResult.click();

    // Click the Impersonate button
    const impersonateButton = dialog.getByRole("button", { name: "Impersonate" });
    await expect(impersonateButton).toBeEnabled({ timeout: 5000 });
    await impersonateButton.click();

    // Wait for page reload after impersonation
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000); // Extra wait for reload

    // Verify impersonation is active - check for red border on the user button
    const userButton = page.locator('[data-slot="sidebar-menu-button"]').last();
    await expect(userButton).toBeVisible({ timeout: 10000 });

    // The button should have the destructive border class when impersonating
    await expect(userButton).toHaveClass(/border-destructive/, { timeout: 10000 });

    // Open the user dropdown again
    await userButton.click();

    // Verify "Stop impersonating" option is visible
    const stopImpersonatingOption = page.getByText("Stop impersonating");
    await expect(stopImpersonatingOption).toBeVisible({ timeout: 5000 });

    // The user name should now show the target user's name
    await expect(page.getByText("Target User")).toBeVisible();

    // Click "Stop impersonating"
    await stopImpersonatingOption.click();

    // Wait for page reload
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Verify we're back to the admin user - check that the button no longer has the red border
    const userButtonAfter = page.locator('[data-slot="sidebar-menu-button"]').last();
    await expect(userButtonAfter).toBeVisible({ timeout: 10000 });

    // The button should NOT have the destructive border anymore
    await expect(userButtonAfter).not.toHaveClass(/border-destructive/, { timeout: 5000 });

    // Open dropdown and verify admin user is shown
    await userButtonAfter.click();
    await expect(page.getByText("Test Admin")).toBeVisible();

    // Cleanup: delete test users
    await fetch(`${baseURL}/api/trpc/testing.cleanupTestData`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: adminEmail }),
    });
    await fetch(`${baseURL}/api/trpc/testing.cleanupTestData`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: targetEmail }),
    });
  });

  test("non-admin user does not see impersonation option", async ({ page, baseURL }) => {
    const timestamp = Date.now();
    const regularEmail = `regular-${timestamp}+test@nustom.com`;

    // Create regular user via testing API
    const createUserResponse = await fetch(`${baseURL}/api/trpc/testing.createTestUser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: regularEmail,
        name: "Regular User",
        role: "user",
      }),
    });
    expect(createUserResponse.ok).toBe(true);

    // Login as regular user
    await login(page, regularEmail, baseURL);
    await ensureOrganization(page);
    await ensureProject(page);

    // Wait for the page to fully load
    await page.waitForLoadState("networkidle");

    // Open the user dropdown in the sidebar footer
    const userDropdownTrigger = page.locator('[data-slot="sidebar-menu-button"]').last();
    await expect(userDropdownTrigger).toBeVisible({ timeout: 10000 });
    await userDropdownTrigger.click();

    // Verify "Impersonate another user" option is NOT visible
    const impersonateOption = page.getByText("Impersonate another user");
    await expect(impersonateOption).not.toBeVisible({ timeout: 3000 });

    // Cleanup: delete test user
    await fetch(`${baseURL}/api/trpc/testing.cleanupTestData`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: regularEmail }),
    });
  });

  test("admin can impersonate by user ID", async ({ page, baseURL }) => {
    const timestamp = Date.now();
    const adminEmail = `admin-uid-${timestamp}+test@nustom.com`;
    const targetEmail = `target-uid-${timestamp}+test@nustom.com`;

    // Create admin user via testing API
    await fetch(`${baseURL}/api/trpc/testing.createTestUser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: adminEmail,
        name: "Test Admin UID",
        role: "admin",
      }),
    });

    // Create target user via testing API and get their ID
    const createTargetResponse = await fetch(`${baseURL}/api/trpc/testing.createTestUser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: targetEmail,
        name: "Target User UID",
        role: "user",
      }),
    });
    const targetUserData = (await createTargetResponse.json()) as {
      result?: { data?: { id?: string } };
    };
    const targetUserId = targetUserData.result?.data?.id;
    if (!targetUserId) {
      throw new Error("Failed to get target user ID from API response");
    }

    // Login as admin
    await login(page, adminEmail, baseURL);
    await ensureOrganization(page);
    await ensureProject(page);

    await page.waitForLoadState("networkidle");

    // Open the user dropdown
    const userDropdownTrigger = page.locator('[data-slot="sidebar-menu-button"]').last();
    await expect(userDropdownTrigger).toBeVisible({ timeout: 10000 });
    await userDropdownTrigger.click();

    // Click "Impersonate another user"
    const impersonateOption = page.getByText("Impersonate another user");
    await impersonateOption.click();

    // Wait for dialog
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Change the identification method to "By User ID"
    const selectTrigger = dialog.locator('[data-slot="select-trigger"]');
    await selectTrigger.click();

    const userIdOption = page.getByRole("option", { name: "By User ID" });
    await userIdOption.click();

    // Enter the user ID
    const userIdInput = dialog.locator('input[placeholder="usr_xxxxxxxxxxxxxxxxxxxxxxxx"]');
    await expect(userIdInput).toBeVisible();
    await userIdInput.fill(targetUserId);

    // Click Impersonate
    const impersonateButton = dialog.getByRole("button", { name: "Impersonate" });
    await expect(impersonateButton).toBeEnabled({ timeout: 5000 });
    await impersonateButton.click();

    // Wait for page reload
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Verify impersonation is active
    const userButton = page.locator('[data-slot="sidebar-menu-button"]').last();
    await expect(userButton).toHaveClass(/border-destructive/, { timeout: 10000 });

    // Cleanup
    await fetch(`${baseURL}/api/trpc/testing.cleanupTestData`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: adminEmail }),
    });
    await fetch(`${baseURL}/api/trpc/testing.cleanupTestData`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: targetEmail }),
    });
  });
});
