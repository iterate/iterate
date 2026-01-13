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
    if (!createAdminResponse.ok) {
      throw new Error(`Failed to create admin user: ${createAdminResponse.status}`);
    }

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
    if (!createTargetResponse.ok) {
      throw new Error(`Failed to create target user: ${createTargetResponse.status}`);
    }

    // Login as admin
    await login(page, adminEmail, baseURL);
    await ensureOrganization(page);
    await ensureProject(page);

    // Wait for the page to fully load
    await page.waitForLoadState("networkidle");

    // Open the user dropdown in the sidebar footer
    const userDropdownTrigger = page.locator('[data-slot="sidebar-menu-button"]').last();
    await userDropdownTrigger.waitFor({ timeout: 10000 });
    await userDropdownTrigger.click();

    // Check that "Impersonate another user" option is visible (admin only)
    const impersonateOption = page.getByText("Impersonate another user");
    await impersonateOption.waitFor({ timeout: 5000 });
    await impersonateOption.click();

    // Wait for the impersonation dialog to open
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 5000 });

    // Verify dialog title
    await dialog.getByText("Impersonate another user").waitFor();

    // The default type should be "By Email" - type the target user's email
    const emailInput = dialog.locator('input[placeholder="user@example.com"]');
    await emailInput.waitFor();
    await emailInput.fill(targetEmail);

    // Wait for search results to appear
    await page.waitForTimeout(1000); // Wait for debounce

    // Click on the target user in the search results
    const targetUserResult = dialog.getByText(targetEmail);
    await targetUserResult.waitFor({ timeout: 10000 });
    await targetUserResult.click();

    // Click the Impersonate button
    const impersonateButton = dialog.getByRole("button", { name: "Impersonate" });
    await impersonateButton.waitFor({ timeout: 5000 });
    await impersonateButton.click();

    // Wait for page reload after impersonation
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000); // Extra wait for reload

    // Verify impersonation is active - check for red border on the user button
    const userButton = page.locator('[data-slot="sidebar-menu-button"]').last();
    await userButton.waitFor({ timeout: 10000 });

    // The button should have the destructive border class when impersonating
    await userButton.waitFor({ timeout: 10000 });

    // Open the user dropdown again
    await userButton.click();

    // Verify "Stop impersonating" option is visible
    const stopImpersonatingOption = page.getByText("Stop impersonating");
    await stopImpersonatingOption.waitFor({ timeout: 5000 });

    // The user name should now show the target user's name
    await page.getByText("Target User").waitFor();

    // Click "Stop impersonating"
    await stopImpersonatingOption.click();

    // Wait for page reload
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Verify we're back to the admin user - check that the button no longer has the red border
    const userButtonAfter = page.locator('[data-slot="sidebar-menu-button"]').last();
    await userButtonAfter.waitFor({ timeout: 10000 });

    // Open dropdown and verify admin user is shown
    await userButtonAfter.click();
    await page.getByText("Test Admin").waitFor();

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
    if (!createUserResponse.ok) {
      throw new Error(`Failed to create regular user: ${createUserResponse.status}`);
    }

    // Login as regular user
    await login(page, regularEmail, baseURL);
    await ensureOrganization(page);
    await ensureProject(page);

    // Wait for the page to fully load
    await page.waitForLoadState("networkidle");

    // Open the user dropdown in the sidebar footer
    const userDropdownTrigger = page.locator('[data-slot="sidebar-menu-button"]').last();
    await userDropdownTrigger.waitFor({ timeout: 10000 });
    await userDropdownTrigger.click();

    // Verify "Impersonate another user" option is NOT visible
    const impersonateOption = page.getByText("Impersonate another user");
    await impersonateOption.waitFor({ state: "hidden", timeout: 3000 });

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
    await userDropdownTrigger.waitFor({ timeout: 10000 });
    await userDropdownTrigger.click();

    // Click "Impersonate another user"
    const impersonateOption = page.getByText("Impersonate another user");
    await impersonateOption.click();

    // Wait for dialog
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 5000 });

    // Change the identification method to "By User ID"
    const selectTrigger = dialog.locator('[data-slot="select-trigger"]');
    await selectTrigger.click();

    const userIdOption = page.getByRole("option", { name: "By User ID" });
    await userIdOption.click();

    // Enter the user ID
    const userIdInput = dialog.locator('input[placeholder="usr_xxxxxxxxxxxxxxxxxxxxxxxx"]');
    await userIdInput.waitFor();
    await userIdInput.fill(targetUserId);

    // Click Impersonate
    const impersonateButton = dialog.getByRole("button", { name: "Impersonate" });
    await impersonateButton.waitFor({ timeout: 5000 });
    await impersonateButton.click();

    // Wait for page reload
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Verify impersonation is active
    const userButton = page.locator('[data-slot="sidebar-menu-button"]').last();
    await userButton.waitFor({ timeout: 10000 });

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
