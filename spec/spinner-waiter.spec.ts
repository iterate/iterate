import { expect } from "@playwright/test";
import { spinnerWaiter } from "./plugins/index.ts";
import { test } from "./test-helpers.ts";

// normally I'd say just copy-paste the code, but it's v important that the actions are identical because test.fail is too "easy" to make pass succeed otherwise.
async function run(page: import("@playwright/test").Page) {
  await page.goto(`/dev`);
  await page.locator("button", { hasText: "slow button" }).click();
  await page.locator("button", { hasText: "i have been clicked" }).waitFor();
}

test("slow button succeeds when there's a spinner", async ({ page }) => {
  await run(page);
});

/* eslint-disable no-restricted-syntax -- expect ok here */

test("slow button fails without spinner waiter", async ({ page }) => {
  spinnerWaiter.settings.enterWith({ disabled: true });
  const error = await run(page).catch((e) => e);
  expect(error.message).toMatch(/Timeout .* exceeded/);
});

test("slow button fails when spinner doesn't match selector", async ({ page }) => {
  spinnerWaiter.settings.enterWith({ spinnerSelectors: [".myCustomSpinnerClass"] });
  const error = await run(page).catch((e) => e);
  expect(error.message).toMatch(/Timeout .* exceeded/);
  expect(error.message).toMatch(/If this is a slow operation.../);
});

test("slow button fails when spinner times out", async ({ page }) => {
  spinnerWaiter.settings.enterWith({ spinnerTimeout: 1001 });
  // make the slow button even slower, must take longer than 1s (initial timeout) +1s (minimum spinner timeout) + 1s (last chance) + any time for chugging along
  await page.goto(`/dev?slowMutationTimeout=6000`);
  const error = await run(Object.assign(page, { goto: () => {} })).catch((e) => e);
  expect(error.message).toMatch(/Timeout .* exceeded/);
  expect(error.message).toMatch(/spinner was still visible after .*/i);
});
