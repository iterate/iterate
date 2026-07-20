import { expect } from "@playwright/test";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

// Deliberately hostile markdown: repo content is user-supplied, so the
// preview must render prose without executing embedded HTML/JS.
const NOTES_MD = `# Release notes

Plain paragraph with **bold** text.

- first item
- second item

<script>document.title = "pwned"</script>
<img src="x" onerror="document.title = 'pwned'" />
`;

test("markdown files get a sanitized Code | Preview toggle in the repo IDE", async ({
  helpers,
  page,
  baseURL,
}) => {
  await using fixture = await helpers.createFixture("md-preview");
  await using _repo = await seedRepoWithMarkdown(baseURL!, fixture.project.id, {
    "notes.md": NOTES_MD,
  });

  await page.goto(`/projects/${fixture.project.slug}/repos/demo?file=notes.md`);

  // The editor opens in Code view: markdown source, not rendered prose.
  await page.locator(".cm-content").getByText("# Release notes").waitFor();

  // Preview renders headings/lists as prose...
  await page.getByRole("tab", { name: "Preview" }).click();
  await page.getByRole("heading", { name: "Release notes" }).waitFor();
  await page.getByRole("listitem").filter({ hasText: "second item" }).waitFor();

  // ...but the embedded <script> and onerror handler must not have run.
  expect(await page.title()).not.toBe("pwned");

  // Back to Code, edit WITHOUT committing: the preview shows the live
  // working-tree buffer, not HEAD.
  await page.getByRole("tab", { name: "Code" }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("# Unsaved draft heading");
  await page.getByRole("tab", { name: "Preview" }).click();
  await page.getByRole("heading", { name: "Unsaved draft heading" }).waitFor();

  // Clicking the modified file in the Source Control panel opens its DIFF —
  // the lingering preview state must not hijack it.
  // getByTitle: the activity-strip button's accessible name is its dirty-count
  // badge ("1"), not the title.
  await page.getByTitle("Source control").click();
  await page.getByRole("button", { name: "notes.md" }).click();
  await page.getByText("(Working Tree)").waitFor();
  await page.locator(".cm-content").waitFor();
});

/** Creates `/repos/demo` in the project and commits the given files to HEAD. */
async function seedRepoWithMarkdown(
  baseUrl: string,
  projectId: string,
  files: Record<string, string>,
) {
  const admin = await connectAdminItx(baseUrl);
  const repo = admin.projects.get(projectId).repos.get("/repos/demo");
  await repo.create({ type: "empty" });
  await repo.commitFiles({
    message: "seed markdown fixture",
    changes: Object.entries(files).map(([path, content]) => ({ path, content })),
  });
  return admin;
}
