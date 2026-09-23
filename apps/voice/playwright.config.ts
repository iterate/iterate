import { defineConfig, devices } from "@playwright/test";
import { deployedTarget } from "../os/e2e/support/deployed-target.ts";

const baseURL = process.env.VOICE_BASE_URL;
const issuer = process.env.DEMO_BASE_URL;
if (!baseURL || !issuer)
  throw new Error("Set VOICE_BASE_URL and DEMO_BASE_URL for the Voice smoke test");
if (process.env.APP_CONFIG) process.env.LOGIN_PASSWORD = deployedTarget(issuer).loginPassword;

export default defineConfig({
  testDir: "specs",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    video: process.env.VIDEO_MODE === "1" ? "on" : "off",
  },
});
