import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";
import { openRepoTreeFile } from "./test-support/repo-tree.ts";

/**
 * JSON/YAML schema validation: a well-known file (here `package.json`, mapped
 * to its schemastore.org schema) gets red squigglies on schema violations, the
 * same @codemirror/lint underline vscode shows. The schema is fetched
 * client-side and cached for the session; this spec depends on schemastore
 * being reachable (the feature's real dependency — it degrades to no
 * diagnostics if the fetch fails).
 */
test("flags a package.json schema violation with a red squiggle", async ({
  helpers,
  page,
  adminItx,
}) => {
  await using fixture = await helpers.createFixture("repo-ide-schema");

  using project = adminItx.projects.get(fixture.project.id);
  await project.repos.get("/repos/ide").create({ type: "empty" });
  // `name` must be a string per the package.json schema — a number is a clear,
  // stable violation.
  await project.repos.get("/repos/ide").commitFiles({
    message: "Add invalid package.json",
    changes: [{ path: "package.json", content: '{\n  "name": 123\n}\n' }],
  });

  await page.goto(`/projects/${fixture.project.slug}/repos/ide`);

  await openRepoTreeFile(page, "package.json");
  await page.locator(".cm-content").filter({ hasText: '"name": 123' }).waitFor();

  // Once the schema loads, the invalid value gets the lint squiggle. The
  // schemastore fetch + lint pass run in the background with no spinner, so
  // spinner-waiter clamps a locator.waitFor here to its 1ms no-spinner
  // fail-fast; the web-first assertion is not middleware-instrumented and
  // keeps the generous 20s budget the one-off fetch needs.
  // oxlint-disable-next-line iterate/spec-restricted-syntax -- no spinner exists during the background schemastore fetch, so locator.waitFor gets fail-fasted to 1ms; expect().toBeVisible() polls the full 20s.
  await expect(page.locator(".cm-lintRange-error").first()).toBeVisible({ timeout: 20_000 });
});
