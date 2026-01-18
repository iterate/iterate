import { expect } from "@playwright/test";
import { spinnerWaiter } from "./plugins/index.ts";
import { test as base } from "./test-helpers.ts";

const test = base.extend<{ slowMutationTimeout: number }>({
  slowMutationTimeout: 2000,
  page: async ({ page, slowMutationTimeout }, use) => {
    await page.setContent(getTestPageHtml(slowMutationTimeout));
    await use(page);
  },
});

async function run(page: import("@playwright/test").Page) {
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

test.extend({ slowMutationTimeout: 6000 })("xyz", async ({ page }) => {
  spinnerWaiter.settings.enterWith({ spinnerTimeout: 3001 });
  const error = await run(page).catch((e) => e);
  expect(error.message).toMatch(/Timeout .* exceeded/);
  expect(error.message).toMatch(/spinner was still visible after .*/i);
});

const testSlower = test.extend({ slowMutationTimeout: 6000 });
testSlower("slow button fails when spinner times out", async ({ page }) => {
  spinnerWaiter.settings.enterWith({ spinnerTimeout: 3001 });
  const error = await run(page).catch((e) => e);
  expect(error.message).toMatch(/Timeout .* exceeded/);
  expect(error.message).toMatch(/spinner was still visible after .*/i);
});

function getTestPageHtml(slowMutationTimeout: number) {
  return `
    <head><title>Spinner Waiter Test</title></head>
    <body>
      <button id="slow-button" onclick="handleClick()">slow button</button>
      <script>
        async function handleClick() {
          const btn = document.querySelector('#slow-button');
          btn.textContent = 'loading...';
          setTimeout(() => btn.textContent = 'i have been clicked', ${slowMutationTimeout});
        }
      </script>
    </body>
  `;
}
