import type { Page } from "@playwright/test";
import { EXAMPLE_CASES } from "../apps/os/src/itx/e2e/example-cases.ts";
import { ITX_EXAMPLES } from "../apps/os/src/itx/examples.ts";
import { test } from "./test-support/test.ts";

const REPL_EXAMPLES = Object.entries(EXAMPLE_CASES).map(([id, exampleCase]) => {
  const example = ITX_EXAMPLES.find((candidate) => candidate.id === id);
  if (!example) throw new Error(`example-cases.ts references missing example ${id}`);
  if (!example.runtimes.includes("browser")) {
    throw new Error(`example-cases.ts example ${id} is not marked runnable in the browser REPL`);
  }
  return { example, exampleCase };
});

test.describe("itx REPL catalogue examples", () => {
  test.setTimeout(300_000);

  test("runs every example-cases snippet through the project REPL", async ({ helpers, page }) => {
    await using fixture = await helpers.createFixture("repl-examples");
    await page.goto(`/projects/${fixture.project.slug}/repl`);
    await page.getByRole("button", { name: "Run" }).waitFor();
    await page.getByTestId("itx-repl-editor").locator(".cm-content").waitFor();

    for (const { example, exampleCase } of REPL_EXAMPLES) {
      await test.step(example.id, async () => {
        const ctx = {
          marker: `playwright-${example.id}-${crypto.randomUUID().slice(0, 8)}`,
          projectId: fixture.project.id,
        };
        const vars = exampleCase.vars ? exampleCase.vars(ctx) : {};

        await runReplSnippet(page, `vars = ${JSON.stringify(vars, null, 2)};`);
        const result = await runReplSnippet(page, example.code);

        try {
          exampleCase.assert(result, ctx);
        } catch (error) {
          throw new Error(
            `REPL example ${example.id} returned an unexpected result: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          );
        }
      });
    }
  });
});

async function runReplSnippet(page: Page, code: string) {
  const entries = page.getByTestId("itx-repl-entry");
  const entryIndex = await entries.count();

  await replaceReplCode(page, code);
  await page.getByRole("button", { name: "Run" }).click();

  const entry = entries.nth(entryIndex);
  await entry.waitFor();

  const status = await entry.getAttribute("data-status");
  if (status !== "success") {
    const errorText = await entry.getByTestId("itx-repl-error").textContent();
    throw new Error(`REPL snippet failed:\n${errorText || (await entry.textContent())}`);
  }

  const resultJson = await entry.getByTestId("itx-repl-result-json").textContent();
  if (!resultJson) throw new Error("REPL snippet succeeded without a serialized result.");

  try {
    return JSON.parse(resultJson);
  } catch (error) {
    throw new Error(
      `REPL snippet returned non-JSON output:\n${resultJson}\n${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function replaceReplCode(page: Page, code: string) {
  const editor = page.getByTestId("itx-repl-editor").locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(code);
}
