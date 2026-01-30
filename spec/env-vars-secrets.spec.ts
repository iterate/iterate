import {
  login,
  test,
  createOrganization,
  createProject,
  sidebarButton,
  toast,
} from "./test-helpers.ts";

test.describe("env vars", () => {
  test("page shows 'Env vars' in nav", async ({ page }) => {
    const timestamp = Date.now();
    await login(page, `test-${timestamp}+test@nustom.com`);
    await createOrganization(page);
    await createProject(page);

    await sidebarButton(page, "Env vars").waitFor();
  });

  test("shows global env vars", async ({ page }) => {
    const timestamp = Date.now();
    await login(page, `test-${timestamp}+test@nustom.com`);
    await createOrganization(page);
    await createProject(page);
    await sidebarButton(page, "Env vars").click();

    // Global env vars should be visible (use first() since key appears in value too)
    await page.getByText("OPENAI_API_KEY").first().waitFor();
    await page.getByText("ANTHROPIC_API_KEY").first().waitFor();

    // Verify they're marked as Global
    await page.getByText("Global").first().waitFor();
  });

  test("can add a plain env var", async ({ page }) => {
    const timestamp = Date.now();
    await login(page, `test-${timestamp}+test@nustom.com`);
    await createOrganization(page);
    await createProject(page);
    await sidebarButton(page, "Env vars").click();

    // Click add button
    await page.getByRole("button", { name: /Add Environment Variable/i }).click();

    // Fill in env var form
    await page.locator("#env-key").fill(`TEST_VAR_${timestamp}`);
    await page.locator("#env-value").fill("test_value");

    // Submit form
    await page.getByRole("button", { name: "Add" }).click();

    // Verify success toast
    await toast.success(page, "Environment variable saved").waitFor();

    // Verify env var appears in list
    await page.getByText(`TEST_VAR_${timestamp}`).waitFor();
    await page.getByText("test_value").waitFor();
  });

  test("can add a secret env var", async ({ page }) => {
    const timestamp = Date.now();
    await login(page, `test-${timestamp}+test@nustom.com`);
    await createOrganization(page);
    await createProject(page);
    await sidebarButton(page, "Env vars").click();

    // Click add button
    await page.getByRole("button", { name: /Add Environment Variable/i }).click();

    // Fill in env var form with secret checkbox
    const keyName = `SECRET_VAR_${timestamp}`;
    await page.locator("#env-key").fill(keyName);
    await page.locator("#env-value").fill("secret_value_123");
    await page.locator("#is-secret").check();

    // Submit form
    await page.getByRole("button", { name: "Add" }).click();

    // Verify success toast
    await toast.success(page, "Environment variable saved").waitFor();

    // Verify env var appears with magic string value (use first() since key appears in value too)
    await page.getByText(keyName).first().waitFor();
    await page.getByText(`getIterateSecret({secretKey: 'env.${keyName}'`).waitFor();
  });

  test("can delete a user-defined env var", async ({ page }) => {
    const timestamp = Date.now();
    await login(page, `test-${timestamp}+test@nustom.com`);
    await createOrganization(page);
    await createProject(page);
    await sidebarButton(page, "Env vars").click();

    // First add an env var
    await page.getByRole("button", { name: /Add Environment Variable/i }).click();
    const keyName = `DELETE_ME_${timestamp}`;
    await page.locator("#env-key").fill(keyName);
    await page.locator("#env-value").fill("to_be_deleted");
    await page.getByRole("button", { name: "Add" }).click();
    await toast.success(page, "Environment variable saved").waitFor();

    // Find the card with this env var and click the menu
    const card = page
      .locator("div", { hasText: keyName })
      .filter({ has: page.getByRole("button") });
    await card.getByRole("button").last().click();

    // Click delete
    await page.getByRole("menuitem", { name: "Delete" }).click();

    // Confirm deletion
    await page.getByRole("button", { name: "Delete" }).click();

    // Verify success toast
    await toast.success(page, "Environment variable deleted").waitFor();
  });

  test("secret hint blocks submit until dismissed or secret checked", async ({ page }) => {
    const timestamp = Date.now();
    await login(page, `test-${timestamp}+test@nustom.com`);
    await createOrganization(page);
    await createProject(page);
    await sidebarButton(page, "Env vars").click();

    // Open add form
    await page.getByRole("button", { name: /Add Environment Variable/i }).click();

    // Fill in a key name that triggers the warning (contains API_KEY)
    await page.locator("#env-key").fill("MY_API_KEY");
    await page.locator("#env-value").fill("some_value");

    // Verify warning appears
    await page.getByText("The key name suggests this might be a secret").waitFor();

    // Verify Add button is disabled - wait for it to have the disabled attribute
    await page.locator('button[type="submit"][disabled]').waitFor();

    // Click Dismiss
    await page.getByRole("button", { name: "Dismiss" }).click();

    // Warning should disappear
    await page
      .getByText("The key name suggests this might be a secret")
      .waitFor({ state: "hidden" });

    // Add button should now be enabled - click() will fail if still disabled
    await page.getByRole("button", { name: "Add" }).click();

    // Verify success
    await toast.success(page, "Environment variable saved").waitFor();
  });

  test("checking 'Store as secret' removes warning and enables submit", async ({ page }) => {
    const timestamp = Date.now();
    await login(page, `test-${timestamp}+test@nustom.com`);
    await createOrganization(page);
    await createProject(page);
    await sidebarButton(page, "Env vars").click();

    // Open add form
    await page.getByRole("button", { name: /Add Environment Variable/i }).click();

    // Fill in a key that triggers warning
    await page.locator("#env-key").fill(`SECRET_KEY_${timestamp}`);
    await page.locator("#env-value").fill("my_secret_value");

    // Verify warning appears
    await page.getByText(/suggests this might be a secret/).waitFor();

    // Check "Store as secret"
    await page.locator("#is-secret").check();

    // Warning should be replaced with the encryption info
    await page.getByText("The value will be stored encrypted").waitFor();
    await page.getByText(/suggests this might be a secret/).waitFor({ state: "hidden" });

    // Submit should work
    await page.getByRole("button", { name: "Add" }).click();
    await toast.success(page, "Environment variable saved").waitFor();

    // Verify it was created as a secret
    await page.getByText(`getIterateSecret({secretKey: 'env.SECRET_KEY_${timestamp}'`).waitFor();
  });
});
