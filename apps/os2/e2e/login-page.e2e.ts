import { test, expect } from "@playwright/test";

const TEST_OTP = "424242";

test.describe("login page", () => {
  test("loads and shows email input", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/login`, { timeout: 5000 });
    await expect(page.getByTestId("email-input")).toBeVisible({ timeout: 3000 });
    await expect(page.getByTestId("email-submit-button")).toBeVisible({ timeout: 1000 });
    await expect(page.getByText("Continue with Google")).toBeVisible({ timeout: 1000 });
  });

  test("can log in with email OTP", async ({ page, baseURL }) => {
    const email = `login-test-${Date.now()}+test@example.com`;

    await page.goto(`${baseURL}/login`, { timeout: 5000 });

    const emailInput = page.getByTestId("email-input");
    const submitButton = page.getByTestId("email-submit-button");

    await expect(emailInput).toBeVisible();
    await expect(submitButton).toBeVisible();

    await emailInput.fill(email);
    await submitButton.click();

    // Wait for the OTP verification screen to appear
    await expect(page.getByText("Enter verification code")).toBeVisible({ timeout: 15000 });

    const firstOtpInput = page.locator('input[inputmode="numeric"]').first();
    await firstOtpInput.focus();
    for (const digit of TEST_OTP) {
      await page.keyboard.press(digit);
    }

    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 10000 });
    expect(page.url()).not.toContain("/login");
  });
});
