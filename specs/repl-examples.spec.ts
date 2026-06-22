import { expect, type Page } from "@playwright/test";
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
  for (const { example, exampleCase } of REPL_EXAMPLES) {
    test(`runs "${example.id}" through the project REPL`, async ({ helpers, page }) => {
      await using fixture = await helpers.createFixture(`repl-${example.id}`);
      await page.goto(`/projects/${fixture.project.slug}/repl`);
      await page.getByRole("button", { name: "Run" }).waitFor();
      page.videoMode.setStartTime(); // start video from now
      await page.getByTestId("itx-repl-editor").locator(".cm-content").waitFor();

      const ctx = {
        marker: `playwright-${example.id}-${crypto.randomUUID().slice(0, 8)}`,
        projectId: fixture.project.id,
      };
      // const vars = exampleCase.vars ? exampleCase.vars(ctx) : {};

      const entries = page.getByTestId("itx-repl-entry");
      const entryIndex = await entries.count();

      let code = `const vars = ${JSON.stringify(exampleCase.vars?.(ctx), null, 2)};`;
      code += `\n\n${example.code}`;

      const editor = page.getByTestId("itx-repl-editor").locator(".cm-content");
      await editor.click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText(code);

      await page.getByRole("button", { name: "Run" }).click();

      const entry = page.locator(`[data-entry-index="${entryIndex}"][data-status="success"]`);
      await entry.waitFor();

      await entry.getByTestId("itx-repl-result-json").waitFor({ state: "attached" });
      const resultJson = await entry.getByTestId("itx-repl-result-json").textContent();
      const result = JSON.parse(resultJson!);

      exampleCase.assert(result, ctx, expect as never);
      const visibleResult = entry.getByTestId("itx-repl-visible-result");
      await visibleResult.locator(".cm-SerializedObjectCodeBlock .cm-content").waitFor();
      if (example.id === "import-npm-via-esm-sh") {
        await visibleResult.getByText("hellothere").waitFor();
      }

      // if (example.id.includes("esm-sh")) {
      // await entry.getByTestId("itx-repl-result-json").getByText(fixture.project.id).waitFor();
      // await entry
      //   .getByTestId("itx-repl-result-json")
      //   .getByText(fixture.project.id, { exact: true })
      //   .click();
      // // }

      // await page.locator(".sdofijsdoifjdf").waitFor();

      // await new Promise((resolve) => setTimeout(resolve, 1000));
    });
  }
});
