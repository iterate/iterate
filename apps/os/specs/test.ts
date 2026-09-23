import { test as base } from "@playwright/test";
import { addPlugins, videoMode } from "middlewright";

/** Keep normal runs fast; VIDEO_MODE=1 adds pointer annotations and removes dead air. */
export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await using recorded = await addPlugins({
      page,
      testInfo,
      plugins: [process.env.VIDEO_MODE === "1" && videoMode({ finalHold: 2 })],
    });
    await use(recorded);
  },
});
