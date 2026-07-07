import { defineConfig, devices } from "@playwright/test";

/**
 * Standalone Playwright config for the integration OAuth consent specs
 * (e2e/playwright). These drive a REAL browser through the human half of an
 * OAuth connect — the consent page of the deployed dummy-petshop — which the
 * node itx e2e (integrations-petshop.e2e.test.ts) deliberately skips via the
 * `approve=1` lane. Point `PETSHOP_BASE_URL` at a deployed dummy-petshop
 * (e.g. https://dummy-petshop.iterate-preview-3.com); there is no local web
 * server to start.
 */
const petshopBaseUrl = process.env.PETSHOP_BASE_URL;

export default defineConfig({
  testDir: "e2e/playwright",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  use: {
    baseURL: petshopBaseUrl,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
