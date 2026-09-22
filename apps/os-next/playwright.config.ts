// playwright.config.ts — the BROWSER E2E, apps/os-shaped. Playwright boots a real local worker
// (`wrangler dev`) and drives the issuer's pages (the consent flow) and a project host's mini-app
// through Chromium: a real browser → the capnweb fork → a real worker.
//
// SWAPPABLE by design: point DEMO_BASE_URL at a preview/live deployment (or a self-hosted runtime)
// and the same spec runs against it — no local worker booted. That is the whole reason these are
// interface E2Es and not workerd-internal tests.

import { defineConfig, devices } from "@playwright/test";
import { deployedTarget } from "./e2e/support/deployed-target.ts";

const PORT = Number(process.env.DEMO_PORT || 8788);
const baseURL = process.env.DEMO_BASE_URL || `http://localhost:${PORT}`;

// A deployment under `doppler run`: the specs read the deployed target out of the environment
// (auth.spec.ts, mini-app.spec.ts, issuer-pages.spec.ts), and the worker processes inherit what is
// set here — the credentials out of the deployment's APP_CONFIG, the routing out of its envs.ts
// entry, the way e2e/support/global-setup.ts hands them to the vitest suite.
if (process.env.DEMO_BASE_URL && process.env.APP_CONFIG) {
  const target = deployedTarget(process.env.DEMO_BASE_URL);
  process.env.ADMIN_API_SECRET = target.adminApiSecret;
  process.env.LOGIN_PASSWORD = target.loginPassword;
  process.env.PROJECT_INGRESS_ROUTING = target.ingressRouting;
  process.env.MCP_BASE_URL = target.mcpBaseUrl;
}

export default defineConfig({
  testDir: "specs",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  // Every spec stamps its own identities (`stamp()`), so files and tests run side by side; a laptop
  // keeps Playwright's default worker count, CI runs against a deployed preview and can fan out.
  fullyParallel: true,
  workers: process.env.CI ? 6 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    video:
      process.env.VIDEO_MODE === "1" ? { mode: "on", size: { width: 1280, height: 1000 } } : "off",
  },
  // Boot a local worker only for a localhost target; a DEMO_BASE_URL to a deployment skips it.
  webServer: process.env.DEMO_BASE_URL
    ? undefined
    : {
        command: `pnpm dev -- --port ${PORT}`,
        url: `${baseURL}/version`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Keep the expanded project form in view in walkthrough recordings.
        ...(process.env.VIDEO_MODE === "1" && { viewport: { width: 1280, height: 1000 } }),
      },
    },
    // the consent flow once more at a phone's width, with touch — Chromium, the same worker
    {
      name: "phone",
      use: { ...devices["Pixel 7"] },
      testMatch: ["**/auth.spec.ts", "**/issuer-pages.spec.ts"],
    },
  ],
});
