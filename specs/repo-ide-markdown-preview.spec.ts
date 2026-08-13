import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";
import { openRepoTreeFile } from "./test-support/repo-tree.ts";

/**
 * The markdown file's Code / Preview toggle: a `.md` buffer renders to HTML
 * (the same streamdown/MessageResponse pipeline the chat uses, GitHub-sanitized)
 * from the live working-tree text. Toggling back to Code returns the editable
 * CodeMirror buffer.
 */
test("toggle a markdown file between Code and its rendered Preview", async ({
  helpers,
  page,
  baseURL,
}) => {
  await using fixture = await helpers.createFixture("repo-ide-md");

  using itx = await connectAdminItx(baseURL!);
  using project = itx.projects.get(fixture.project.id);
  await project.repos.get("/repos/ide").create({ type: "empty" });
  // Seed a small markdown file rather than opening the large template README:
  // a short buffer settles CodeMirror well inside the tight action budget, so
  // the toggle stays clickable (and the demo reads cleanly).
  await project.repos.get("/repos/ide").commitFiles({
    message: "Add demo.md",
    changes: [
      {
        path: "demo.md",
        content: ["# Hello from the repo IDE", "", "A **markdown** file with a `code` span."].join(
          "\n",
        ),
      },
    ],
  });

  await page.goto(`/projects/${fixture.project.slug}/repos/ide`);

  // Code view: the raw markdown source, including the leading `# ` heading.
  await openRepoTreeFile(page, "demo.md");
  await page.locator(".cm-content").filter({ hasText: "# Hello from the repo IDE" }).waitFor();

  // Preview renders the markdown: the `# Heading` becomes a real <h1>, with no
  // literal `#` in the rendered output. The Code | Preview toggle is a base-ui
  // Tabs pair, so the triggers carry role="tab".
  await page.getByRole("tab", { name: "Preview" }).click();
  await page.getByRole("heading", { name: "Hello from the repo IDE" }).waitFor();

  // Back to Code: the editable source (with the `#` markers) returns.
  await page.getByRole("tab", { name: "Code" }).click();
  await page.locator(".cm-content").filter({ hasText: "# Hello from the repo IDE" }).waitFor();
});
