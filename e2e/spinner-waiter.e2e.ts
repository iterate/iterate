import { test } from "./test-helpers.ts";

test("slow button", async ({ page }) => {
  await page.goto(`/dev`);

  await page.locator("button", { hasText: "slow button" }).click();
  await page.locator("button", { hasText: "i have been clicked" }).waitFor();
});
