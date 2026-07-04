import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

test("project REPL accepts a forged session", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("basic-repl");
  await page.goto(`/projects/${fixture.project.slug}/repl`);
  // exact: the project slug can contain "run", which substring-matches sidebar buttons
  await page.getByRole("button", { name: "Run", exact: true }).waitFor();
  await page.getByTestId("itx-repl-editor").locator(".cm-content").waitFor();

  const entries = page.getByTestId("itx-repl-entry");
  const entryIndex = await entries.count();
  await page.getByRole("button", { name: "Run", exact: true }).click();

  const entry = page.locator(`[data-entry-index="${entryIndex}"][data-status="success"]`);
  await entry.waitFor();

  const resultJson = await entry.getByTestId("itx-repl-result-json").textContent();
  const result = JSON.parse(resultJson!);
  expect(result).toMatchObject({
    children: {
      capabilityHost: expect.any(String),
      streams: expect.any(String),
    },
    projectId: fixture.project.id,
  });
  expect(result.capabilities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: ["capabilityHost"], type: "builtin" }),
      expect.objectContaining({ path: ["streams"], type: "builtin" }),
    ]),
  );
});
