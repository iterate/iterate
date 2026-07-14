import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

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
  baseURL,
}) => {
  await using fixture = await helpers.createFixture("repo-ide-jsonc");

  using itx = await connectAdminItx(baseURL!);
  using project = itx.projects.get(fixture.project.id);
  await project.repos.create({ path: "/repos/ide" });
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

  await page.locator('[data-item-path="tsconfig.json"]').click();
  await page.locator(".cm-content").filter({ hasText: "// jsonc: comments are allowed" }).waitFor();

  // Once the tsconfig schema loads, the invalid `strict` value squiggles — which
  // can only happen if the commented, trailing-comma doc parsed as json5.
  // 20s: generous room for the one-off schemastore fetch.
  await page.locator(".cm-lintRange-error").first().waitFor({ timeout: 20_000 });
});
