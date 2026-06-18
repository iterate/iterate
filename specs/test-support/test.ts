import { test as base } from "@playwright/test";
import {
  addPlugins,
  hydrationWaiter,
  spinnerWaiter,
  uiErrorReporter,
  videoMode,
} from "middlewright";

export const test = base.extend({
  page: async ({ page: basePage }, use, testInfo) => {
    await using page = await addPlugins({
      page: basePage,
      testInfo,
      plugins: [
        hydrationWaiter({ timeout: 30_000 }),
        uiErrorReporter(),
        spinnerWaiter({ spinnerTimeout: 30_000 }),
        process.env.VIDEO_MODE === "1" && videoMode({ skipStackFrames: ["test-support/test.ts"] }),
      ],
      boxedStackPrefixes: (defaults) => [...defaults, import.meta.dirname],
    });

    await use(page);
  },
});

export function uniqueSlug(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
}
