import { expect } from "@playwright/test";
import { spinnerWaiter } from "./spinner-waiter.ts";
import { test } from "./test-helpers.ts";

// normally I'd say just copy-paste the code, but it's v important that the actions are identical because test.fail is too "easy" to make pass succeed otherwise.
async function run(page: import("@playwright/test").Page) {
  await page.goto(`/dev`);
  await page.locator("button", { hasText: "slow button" }).click();
  await page.locator("button", { hasText: "i have been clicked" }).waitFor();
}

test("slow button", async ({ page }) => {
  await run(page);
});

/* eslint-disable no-restricted-syntax -- expect ok here */

test("slow button fails without spinner waiter", async ({ page }) => {
  spinnerWaiter.settings.enterWith({ disabled: true });
  await expect(run(page)).rejects.toThrowError(/Timeout .* exceeded/);
});

test("slow button fails when spinner doesn't match selector", async ({ page }) => {
  spinnerWaiter.settings.enterWith({ spinnerSelectors: [".myCustomSpinnerClass"] });
  await expect(run(page)).rejects.toThrowError(/Timeout .* exceeded/);
});

test("slow button when spinner times out", async ({ page }) => {
  spinnerWaiter.settings.enterWith({ spinnerTimeout: 1001 });
  // make the slow button even slower, must take longer than 1s (initial timeout) +1s (minimum spinner timeout) + 1s (last chance) + any time for chugging along
  await page.goto(`/dev?slowMutationTimeout=6000`);
  await expect(run(Object.assign(page, { goto: () => {} }))).rejects.toThrowError(
    /Timeout .* exceeded/,
  );
});
