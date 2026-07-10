import { expect } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import JSON5 from "json5";
import { EXAMPLE_CASES } from "../apps/os/e2e/examples/example-cases.ts";
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
      // Cold-path examples declare their own completion budget (see
      // ExampleCase.completionTimeoutMs); the playwright test timeout must
      // not undercut it.
      if (exampleCase.completionTimeoutMs) {
        test.setTimeout(exampleCase.completionTimeoutMs + 60_000);
      }
      await using fixture = await helpers.createFixture(`repl-${example.id}`);
      await page.goto(`/projects/${fixture.project.slug}/repl`);
      // exact: the project slug can contain "run", which substring-matches sidebar buttons
      await page.getByRole("button", { name: "Run", exact: true }).waitFor();
      page.videoMode?.setStartTime(); // start video from now
      await page.getByTestId("itx-repl-editor").locator(".cm-content").waitFor();

      const ctx = {
        attemptSalt: crypto.randomUUID().slice(0, 8),
        marker: `playwright-${example.id}-${crypto.randomUUID().slice(0, 8)}`,
        projectId: fixture.project.id,
      };

      const entries = page.getByTestId("itx-repl-entry");
      const entryIndex = await entries.count();

      let code = example.code;
      if (exampleCase.vars) {
        const json = JSON5.stringify(exampleCase.vars(ctx), null, 2);
        code = `const vars = ${json};\n\n${example.code}`;
      }

      const editor = page.getByTestId("itx-repl-editor").locator(".cm-content");
      await editor.fill(code);

      await page.getByRole("button", { name: "Run", exact: true }).click();

      const entry = page.locator(`[data-entry-index="${entryIndex}"][data-status="success"]`);
      if (exampleCase.completionTimeoutMs) {
        // spinner-waiter caps "spinner still visible" waits at 30s, which is
        // exactly the state a long-running example is in — bypass it and wait
        // for the entry directly with the example's own budget.
        await spinnerWaiter.settings.run({ disabled: true }, () =>
          entry.waitFor({ timeout: exampleCase.completionTimeoutMs }),
        );
      } else {
        await entry.waitFor();
      }

      const resultJson = await entry.getByTestId("itx-repl-result-json").textContent();
      const result = JSON.parse(resultJson!);

      exampleCase.assert(result, ctx, expect as never);
      const visibleResult = entry.getByTestId("itx-repl-visible-result");
      await visibleResult.locator(".cm-SerializedObjectCodeBlock .cm-content").waitFor();
    });
  }
});
