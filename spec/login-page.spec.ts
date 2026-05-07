import { login, test, waitForEnabledTestId } from "./test-helpers.ts";

test.describe("login page", () => {
  test("loads wrapper login, then shows email and google options", async ({ page }) => {
    await page.goto("/login");
    await page.getByText("Sign in with Iterate").waitFor();

    await page.getByText("Sign in with Iterate").click();

    await waitForEnabledTestId(page, "email-login-button");
    await waitForEnabledTestId(page, "google-login-button");
  });

  test("clicking email expands the otp form and hides google", async ({ page }) => {
    await page.goto("/login");
    await page.getByText("Sign in with Iterate").click();

    await waitForEnabledTestId(page, "email-login-button");
    await page.getByTestId("email-login-button").click();

    await page.getByTestId("email-input").waitFor();
    await page.getByTestId("email-submit-button").waitFor();
    await page.getByTestId("google-login-button").waitFor({ state: "hidden" });
  });

  test("can log in with email OTP", async ({ page }) => {
    const email = `login-test-${Date.now()}+test@nustom.com`;
    await login(page, email);
  });

  test("sending a test OTP reveals the verification inputs", async ({ page }) => {
    const email = `otp-reveal-${Date.now()}+test@nustom.com`;

    await page.goto("/login");
    await page.getByText("Sign in with Iterate").click();
    await waitForEnabledTestId(page, "email-login-button");
    await page.getByTestId("email-login-button").click();
    await page.getByTestId("email-input").fill(email);
    await page.getByTestId("email-submit-button").click();

    await page.locator('input[inputmode="numeric"]').first().waitFor();
    await page.getByText(`Enter the 6-digit code sent to ${email}`).waitFor();
  });
});
