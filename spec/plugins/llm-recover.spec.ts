import { test as base, expect } from "@playwright/test"; // eslint-disable-line no-restricted-imports -- ok here
import { addPlugins } from "../playwright-plugin.ts";
import { llmRecover } from "./llm-recover.ts";

// These tests hit the real Anthropic API to validate the prompt works.
// Only run when LLM_RECOVER is set (requires ANTHROPIC_API_KEY).
const describe = process.env.LLM_RECOVER ? base.describe : base.describe.skip;

const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await using _page = await addPlugins({
      page,
      testInfo,
      plugins: [llmRecover()],
    });
    await use(_page);
  },
});

describe("llm-recover", () => {
  test("recovers from out-of-date copy", async ({ page }) => {
    await page.setContent(`
      <body>
        <h1>Welcome</h1>
        <button id="create-btn">Create your profile</button>
        <div id="result"></div>
        <script>
          document.getElementById('create-btn').addEventListener('click', function() {
            document.getElementById('result').textContent = 'profile created';
          });
        </script>
      </body>
    `);

    // The test uses stale copy — button actually says "Create your profile"
    await page.getByText("Create profile").click();

    // Recovery should have found and clicked the real button
    await expect(page.locator("#result")).toHaveText("profile created");
  });

  test("recovers from timing issue by waiting", async ({ page }) => {
    await page.setContent(`
      <body>
        <h1>Welcome</h1>
        <p>You'll be able to create your profile in five seconds - hang tight</p>
        <div id="waiting-area"></div>
        <div id="result"></div>
        <script>
          setTimeout(function() {
            document.getElementById('waiting-area').innerHTML =
              '<button id="create-btn">Create your profile</button>';
            document.getElementById('create-btn').addEventListener('click', function() {
              document.getElementById('result').textContent = 'profile created';
            });
          }, 5000);
        </script>
      </body>
    `);

    // Button doesn't exist yet — appears after 5s
    await page.getByText("Create profile").click();

    // Recovery should have waited and then clicked
    await page.getByText("profile created").waitFor();
  });

  test("rethrows with context for genuine error", async ({ page }) => {
    await page.setContent(`
      <body>
        <h1>Welcome</h1>
        <p>Creating profile not allowed for preview users</p>
      </body>
    `);

    // There is no button at all — the page says it's not allowed
    const error: unknown = await page
      .getByText("Create profile")
      .click()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    // The error should have been rethrown (recovery can't fix a missing feature).
    // It may or may not have an LLM-added hint, but it should still be a timeout-style error.
    expect((error as Error).message).toMatch(/Timeout|recovery attempt/i);
  });
});
