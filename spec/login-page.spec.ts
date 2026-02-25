import { expect } from "@playwright/test"; // eslint-disable-line no-restricted-imports -- need expect
import { login, test } from "./test-helpers.ts";

test.describe("login page", () => {
  test("loads and shows email input", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("email-input").waitFor();
    await page.getByTestId("email-submit-button").waitFor();
    await page.getByText("Continue with Google").waitFor();
  });

  test("can log in with email OTP", async ({ page }) => {
    const email = `login-test-${Date.now()}+test@nustom.com`;
    await login(page, email);
  });

  test("OTP step survives page reload", async ({ page }) => {
    const email = `otp-reload-${Date.now()}+test@nustom.com`;

    // Submit email to get to OTP step
    await page.goto("/login");
    await page.getByTestId("email-input").fill(email);
    await page.getByTestId("email-submit-button").click();
    await page.getByText("Enter verification code").waitFor();

    // URL should now contain step=otp and the email
    expect(page.url()).toContain("step=otp");
    expect(page.url()).toContain(encodeURIComponent(email));

    // Reload the page
    await page.reload();

    // OTP screen should still be showing after reload
    await page.getByText("Enter verification code").waitFor();
    await page.getByText(email).waitFor();
  });

  test("navigating directly to OTP step shows OTP screen", async ({ page }) => {
    const email = `otp-direct-${Date.now()}+test@nustom.com`;

    await page.goto(`/login?step=otp&email=${encodeURIComponent(email)}`);

    // Should render the OTP screen directly
    await page.getByText("Enter verification code").waitFor();
    await page.getByText(email).waitFor();
  });
});
