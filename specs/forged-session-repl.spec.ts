import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

test("project REPL accepts a forged session", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("basic-repl");
  await page.goto(`/projects/${fixture.project.slug}/repl`);
  // exact: the project slug can contain "run", which substring-matches sidebar buttons
  await page.getByRole("button", { name: "Run", exact: true }).click();

  // The visible result block clamps long output, and __describe() got huge
  // with #1624 (it inlines the full types source) — so wait for a token from
  // the result's first lines, then assert the semantic bit against the hidden
  // full-JSON mirror, which text assertions can read without visibility.
  await page.getByTestId("itx-repl-visible-result").getByText(`"children"`).waitFor();
  await expect(page.getByTestId("itx-repl-result-json")).toContainText(`"capabilities"`);
});
