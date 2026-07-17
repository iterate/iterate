import { test } from "../test-support/test.ts";

test("the mobile app can be reviewed without an iOS build", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Sign in" }).waitFor();

  await page.getByRole("button", { name: "preview 3" }).click();
  await page.locator('input[value="https://os.iterate-preview-3.com"]').waitFor();
});
