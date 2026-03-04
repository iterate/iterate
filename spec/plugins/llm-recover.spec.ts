import { test as base, expect, type Page } from "@playwright/test"; // eslint-disable-line no-restricted-imports -- ok here
import { addPlugins } from "../playwright-plugin.ts";
import { llmRecover } from "./llm-recover.ts";

// These tests hit the real Anthropic API to validate the prompt works.
// Only run when LLM_RECOVER is set (requires ANTHROPIC_API_KEY).
const describe = process.env.LLM_RECOVER ? base.describe : base.describe.skip;

const test = base.extend<{ page: Page & { assertions: string[] } }>({
  page: async ({ page }, use, testInfo) => {
    const assertions: string[] = [];
    const shimmedExpect = Object.assign((...args: any[]) => expect(...(args as [string])), {
      ...expect,
      soft: (actual: unknown, message: string) => {
        return {
          toBe: (expected: unknown) => {
            assertions.push(`Soft assertion ${actual}!=${expected}: ${message}`);
          },
        };
      },
    }) as typeof expect;
    await using _page = await addPlugins({
      page,
      testInfo,
      plugins: [llmRecover({ expect: shimmedExpect })],
      boxedStackPrefixes: (defaults) => [
        ...defaults,
        import.meta.filename.replace(".spec.ts", ".ts"),
      ],
    });
    await use(Object.assign(_page, { assertions }));
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

    expect(page.assertions).toHaveLength(1);
    expect(page.assertions[0]).toMatch(/click failed and was recovered by LLM/);
    const flat = page.assertions[0].replace(/\n\s*/g, " ").replaceAll(`"`, `'`);
    expect(flat).toMatch(/Original locator: await page.getByText\('Create profile'\)\.click\(\)/);
    expect(flat).toMatch(/Recovery code: await page.getByText\('Create your profile'\)\.click\(\)/);
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
              '<button id="create-btn">Create profile</button>';
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

    expect(page.assertions).toHaveLength(1);
    expect(page.assertions[0]).toMatch(/click failed and was recovered by LLM/);
    const flat = page.assertions[0].replace(/\n\s*/g, " ").replaceAll(`"`, `'`);
    expect(flat).toMatch(/Original locator: await page.getByText\('Create profile'\)\.click\(\)/);
    expect(flat).toMatch(/Recovery code: .*(timeout: \d+)/);
  });

  test("rethrows with context for genuine error", async ({ page }) => {
    await page.setContent(`
      <body>
        <h1>Welcome</h1>
        <p>Creating profile not allowed for preview users</p>
      </body>
    `);

    await expect(async () => {
      await page.getByText("Create profile").click();
    }).rejects.toThrow(/Not recoverable/);
    // expect(page.assertions).toBeNull();
  });
});
