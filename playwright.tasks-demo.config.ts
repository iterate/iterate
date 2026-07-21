import { defineConfig, devices } from "@playwright/test";
import {
  SPEC_ACTION_TIMEOUT_MS,
  SPEC_EXPECT_TIMEOUT_MS,
  SPEC_TEST_TIMEOUT_MS,
} from "@iterate-com/shared/test-support/e2e-policy";

const videoMode = process.env.VIDEO_MODE === "1";

// This disposable production demo needs no local OS or Expo server. Keeping it
// separate prevents unrelated startup work from consuming the recording budget.
export default defineConfig({
  expect: { timeout: SPEC_EXPECT_TIMEOUT_MS },
  outputDir: "test-results/tasks-app-demo",
  reporter: [["list"]],
  testDir: "specs",
  testMatch: "tasks-app-collaboration-demo.spec.ts",
  timeout: videoMode ? 300_000 : SPEC_TEST_TIMEOUT_MS,
  use: {
    ...devices["Desktop Chrome"],
    actionTimeout: videoMode ? 10_000 : SPEC_ACTION_TIMEOUT_MS,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: videoMode ? "on" : "retain-on-failure",
    viewport: { height: 900, width: 1280 },
  },
  workers: 1,
});
