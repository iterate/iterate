import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

/**
 * The html file's Code / Preview toggle: an html buffer renders in a sandboxed
 * iframe (`allow-scripts`, no `allow-same-origin`) that carries the live
 * working-tree text, so unsaved edits preview without a commit. Toggling back
 * to Code returns the editable CodeMirror buffer.
 */
test("toggle an html file between Code and its sandboxed Preview", async ({
  helpers,
  page,
  baseURL,
}) => {
  await using fixture = await helpers.createFixture("repo-ide-html");

  using itx = await connectAdminItx(baseURL!);
  using project = itx.projects.get(fixture.project.id);
  await project.repos.create({ path: "/repos/ide" });
  // The template ships no html, so seed one — a heading and a script-driven
  // button, enough to show the sandbox actually runs the document.
  await project.repos.get("/repos/ide").commitFiles({
    message: "Add index.html",
    changes: [
      {
        path: "index.html",
        content: [
          "<!doctype html>",
          '<html><body style="font-family: system-ui; padding: 2rem">',
          "  <h1>Hello from the repo IDE</h1>",
          "  <button onclick=\"this.textContent = 'Clicked!'\">Click me</button>",
          "</body></html>",
        ].join("\n"),
      },
    ],
  });

  await page.goto(`/projects/${fixture.project.slug}/repos/ide`);

  // Code view first: the header shows the toggle, the buffer shows the source.
  await page.locator('[data-item-path="index.html"]').click();
  await page.locator(".cm-content").filter({ hasText: "Hello from the repo IDE" }).waitFor();

  // Preview renders the buffer in the sandboxed iframe, which carries the
  // exact working-tree html through its srcdoc.
  await page.getByRole("tab", { name: "Preview" }).click({ timeout: 10_000 });
  const preview = page.locator('iframe[title="HTML preview"]');
  await preview.waitFor();
  await preview.and(page.locator('[srcdoc*="Hello from the repo IDE"]')).waitFor();
  // The rendered heading is visible inside the frame.
  await preview.contentFrame().getByRole("heading", { name: "Hello from the repo IDE" }).waitFor();

  // Back to Code: the editable buffer returns.
  await page.getByRole("tab", { name: "Code" }).click({ timeout: 10_000 });
  await page.locator(".cm-content").filter({ hasText: "Hello from the repo IDE" }).waitFor();
});
