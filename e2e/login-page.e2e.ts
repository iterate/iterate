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
});
