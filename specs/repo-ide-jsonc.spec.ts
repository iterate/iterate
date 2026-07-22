import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";
import { openRepoTreeFile } from "./test-support/repo-tree.ts";

/**
 * The jsonc lane: tsconfig-family files (and *.jsonc, .vscode/*.json) parse
 * with the json5 grammar, so comments and trailing commas are not parse errors
 * — while schema validation still runs. A schema squiggle appearing on a file
 * that CONTAINS a comment is the proof: pre-jsonc the comment would fail strict
 * parsing and the schema linter never gets to run.
 *
 * Depends on schemastore being reachable (the tsconfig schema) — the feature's
 * real client-side dependency.
 */
test("a commented tsconfig still schema-validates (comments are tolerated)", async ({
  helpers,
  page,
  adminItx,
}) => {
  await using fixture = await helpers.createFixture("repo-ide-jsonc");

  using project = adminItx.projects.get(fixture.project.id);
  await project.repos.get("/repos/ide").create({ type: "empty" });
  // A comment, a trailing comma, and a schema violation (`strict` must be a
  // boolean). json5 tolerates the first two; the schema flags the third.
  await project.repos.get("/repos/ide").commitFiles({
    message: "Add commented tsconfig with a violation",
    changes: [
      {
        path: "tsconfig.json",
        content: [
          "{",
          "  // jsonc: comments are allowed in tsconfig-family files",
          '  "compilerOptions": {',
          '    "strict": 123,',
          "  },",
          "}",
          "",
        ].join("\n"),
      },
    ],
  });

  await page.goto(`/projects/${fixture.project.slug}/repos/ide`);

  await openRepoTreeFile(page, "tsconfig.json");
  await page.locator(".cm-content").filter({ hasText: "// jsonc: comments are allowed" }).waitFor();

  // Once the tsconfig schema loads, the invalid `strict` value squiggles — which
  // can only happen if the commented, trailing-comma doc parsed as json5. The
  // schemastore fetch + lint pass run in the background with no spinner, so
  // spinner-waiter clamps a locator.waitFor here to its 1ms no-spinner
  // fail-fast; the web-first assertion is not middleware-instrumented and
  // keeps the generous 20s budget the one-off fetch needs.
  // oxlint-disable-next-line iterate/spec-restricted-syntax -- no spinner exists during the background schemastore fetch, so locator.waitFor gets fail-fasted to 1ms; expect().toBeVisible() polls the full 20s.
  await expect(page.locator(".cm-lintRange-error").first()).toBeVisible({ timeout: 20_000 });
});
