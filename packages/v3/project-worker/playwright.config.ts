// playwright.config.ts — the BROWSER E2E, apps/os-shaped. Playwright boots a real local worker
// (`wrangler dev`) and drives the hosted /demo page through Chromium: a real browser → the capnweb
// fork → a real worker → a userspace processor facet → reduced ⊕ runtime live state in the DOM.
//
// SWAPPABLE by design: point DEMO_BASE_URL at a preview/live deployment (or a self-hosted runtime)
// and the same spec runs against it — no local worker booted. That is the whole reason these are
// interface E2Es and not workerd-internal tests.

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.DEMO_PORT ?? 8788);
const baseURL = process.env.DEMO_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: { baseURL, trace: "on-first-retry" },
  // Boot a local worker only for a localhost target; a DEMO_BASE_URL to a deployment skips it.
  webServer: process.env.DEMO_BASE_URL
    ? undefined
    : {
        command: `pnpm exec wrangler dev --port ${PORT}`,
        url: `${baseURL}/version`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
