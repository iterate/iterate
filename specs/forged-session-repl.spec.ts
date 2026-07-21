import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

// Quarantined after a live preview hydration stall; see
// tasks/quarantined-preview-e2e-retry-flakes.md.
test.skip("project REPL accepts a forged session", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("basic-repl");
  await page.goto(`/projects/${fixture.project.slug}/repl`);
  // exact: the project slug can contain "run", which substring-matches sidebar buttons
  await page.getByRole("button", { name: "Run", exact: true }).waitFor();
  const editor = page.getByTestId("itx-repl-editor").locator(".cm-content");
  await editor.waitFor();

  // This spec proves that the forged browser session reaches its claimed
  // project. Keep the call on that contract: the REPL default (__describe)
  // also wakes the project and capability-host Durable Objects, which belong
  // to the separately covered discovery catalogue and made an auth proof draw
  // two unrelated cold-object lifecycle failures.
  await editor.fill("return await itx.identity();");

  const entries = page.getByTestId("itx-repl-entry");
  const entryIndex = await entries.count();
  await page.getByRole("button", { name: "Run", exact: true }).click();

  const entry = page.locator(`[data-entry-index="${entryIndex}"][data-status="success"]`);
  await entry.waitFor();

  const resultJson = await entry.getByTestId("itx-repl-result-json").textContent();
  const result = JSON.parse(resultJson!);
  expect(result).toMatchObject({
    projectId: fixture.project.id,
    slug: fixture.project.slug,
  });
});
