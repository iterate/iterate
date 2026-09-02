import { test } from "../test-support/test.ts";

test("the mobile app can be reviewed without an iOS build", async ({ page }) => {
  // Stamp the bundle (dev-only override, apps/mobile/src/lib/build-state-core.ts)
  // so the expected backend contributes its quick-select chip.
  await page.addInitScript(() => {
    localStorage.setItem(
      "build-info-override",
      JSON.stringify({ expectedBackendEnv: "preview_3" }),
    );
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Sign in" }).waitFor();

  // Quick-select is just Production + the bundle's expected backend — no
  // chip for every preview slot; anything else gets typed in.
  await page.getByRole("button", { name: "Production" }).waitFor();
  await page.getByRole("button", { name: "preview 5" }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "preview 3" }).click();
  await page.locator('input[value="https://os.iterate-preview-3.com"]').waitFor();
});
