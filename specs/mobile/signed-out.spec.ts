import { expect } from "@playwright/test";
import { test } from "../test-support/test.ts";

test("the mobile app can be reviewed without an iOS build", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Sign in" }).waitFor();
  // oxlint-disable-next-line iterate/spec-restricted-syntax -- screenshot comparisons have no locator-only equivalent
  await expect(page).toHaveScreenshot("signed-out-production.png", {
    animations: "disabled",
  });

  await page.getByRole("button", { name: "preview 3" }).click();
  await page.locator('input[value="https://os.iterate-preview-3.com"]').waitFor();
  await page.getByText("Iterate", { exact: true }).scrollIntoViewIfNeeded();
  // oxlint-disable-next-line iterate/spec-restricted-syntax -- screenshot comparisons have no locator-only equivalent
  await expect(page).toHaveScreenshot("signed-out-preview-3.png", {
    animations: "disabled",
  });
});
