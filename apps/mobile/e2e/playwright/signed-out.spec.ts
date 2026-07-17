import { expect, test } from "@playwright/test";

test("the mobile app can be reviewed without an iOS build", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Sign in" }).waitFor();
  await expect(page).toHaveScreenshot("signed-out-production.png", {
    animations: "disabled",
  });

  await page.getByRole("button", { name: "preview 3" }).click();
  await expect(page.getByPlaceholder("https://os.iterate.com")).toHaveValue(
    "https://os.iterate-preview-3.com",
  );
  await page.getByText("Iterate", { exact: true }).scrollIntoViewIfNeeded();
  await expect(page).toHaveScreenshot("signed-out-preview-3.png", {
    animations: "disabled",
  });
});
