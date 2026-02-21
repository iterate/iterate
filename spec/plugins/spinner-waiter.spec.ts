import { test as base, expect } from "@playwright/test"; // eslint-disable-line no-restricted-imports -- ok here
import { addPlugins } from "../playwright-plugin.ts";
import { spinnerWaiter } from "./index.ts";

const test = base.extend<{ slowMutationTimeout: number }>({
  slowMutationTimeout: 2000,
  page: async ({ page, slowMutationTimeout }, use, testInfo) => {
    await using _page = await addPlugins({ page, testInfo, plugins: [spinnerWaiter()] });
    await _page.setContent(getTestPageHtml(slowMutationTimeout));
    await use(_page);
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

const testSlower = test.extend({ slowMutationTimeout: 6000 });
testSlower("slow button fails when spinner times out", async ({ page }) => {
  spinnerWaiter.settings.enterWith({ spinnerTimeout: 3001 });
  const error = await run(page).catch((e) => e);
  expect(error.message).toMatch(/Timeout .* exceeded/);
  expect(error.message).toMatch(/spinner was still visible after .*/i);
});

test("bails early when spinner disappears without expected element", async ({ page }) => {
  // Override page content for this test: spinner shows for 2s then disappears with wrong result
  await page.setContent(`
    <button id="start" onclick="
      document.querySelector('#result').textContent = 'processing...';
      setTimeout(() => document.querySelector('#result').textContent = 'Failed: something went wrong', 2000);
      setTimeout(() => document.querySelector('#result').textContent = 'success', 10_000); // should be too little, too late
    ">start operation</button>
    <div id="result"></div>
  `);

  spinnerWaiter.settings.enterWith({ spinnerTimeout: 30_000 });
  await page.locator("#start").click();

  const start = Date.now();
  const error = await page
    .locator("#result", { hasText: "success" })
    .waitFor()
    .catch((e: Error) => e);
  const elapsed = Date.now() - start;

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/Loading finished.*spinner disappeared/i);
  // Should bail within ~10s (2s spinner + 3s grace + buffer), not wait full 30s
  expect(elapsed).toBeLessThan(15_000);
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
