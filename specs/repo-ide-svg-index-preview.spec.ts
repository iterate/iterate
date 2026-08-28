import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";
import { openRepoTreeFile } from "./test-support/repo-tree.ts";

/**
 * SVG previews through the same sandboxed html iframe as html files (raw svg
 * markup renders inline in an html document), and the Code/Preview toggle also
 * rides along into the readonly Index view — so a staged snapshot can be
 * previewed, not just the working buffer.
 */
test("toggle an svg file between Code and its sandboxed Preview", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("repo-ide-svg");

  using project = await fixture.projectItx();
  await project.repos.get("/repos/ide").create({ type: "empty" });
  await project.repos.get("/repos/ide").commitFiles({
    message: "Add icon.svg",
    changes: [
      {
        path: "icon.svg",
        content:
          '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="tomato" /></svg>',
      },
    ],
  });

  await page.goto(`/projects/${fixture.project.slug}/repos/ide`);

  // Code view shows the svg source.
  await openRepoTreeFile(page, "icon.svg");
  await page.locator(".cm-content").filter({ hasText: "<circle" }).waitFor();

  // Preview renders the svg in the sandboxed iframe (same srcdoc lane as html).
  await page.getByRole("tab", { name: "Preview" }).click();
  const preview = page.locator('iframe[title="HTML preview"]');
  // The tab changes URL-owned view state through a React transition while the
  // usable Code pane remains on screen — no spinner, but the render lands
  // well inside the spinner-waiter's 1s readiness check, so a plain
  // locator wait covers it.
  await preview.waitFor();
  // oxlint-disable-next-line iterate/spec-restricted-syntax -- same bounded search-state transition; this assertion also proves the rendered iframe contains the SVG source.
  await expect(preview).toHaveAttribute("srcdoc", /<circle/);
});

test("preview a staged snapshot from the readonly Index view", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("repo-ide-index");

  using project = await fixture.projectItx();
  await project.repos.get("/repos/ide").create({ type: "empty" });
  await project.repos.get("/repos/ide").commitFiles({
    message: "Add page.html",
    changes: [{ path: "page.html", content: "<h1>Committed</h1>" }],
  });

  await page.goto(`/projects/${fixture.project.slug}/repos/ide`);

  // Edit the html and stage it, then open the readonly "(Index)" pseudo-file.
  await openRepoTreeFile(page, "page.html");
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("<h1>Staged edit</h1>");
  await page.getByRole("button", { name: "Stage" }).click();
  await page.getByRole("button", { name: "Source control" }).click();
  await page.getByRole("button", { name: "page.html" }).first().click();
  await page.getByText("page.html (Index)").waitFor();

  // The Code | Preview toggle rides into the Index view: previewing renders the
  // STAGED snapshot and the header reads "(Index Preview)".
  await page.getByRole("tab", { name: "Preview" }).click();
  await page.getByText("page.html (Index Preview)").waitFor();
  await page.locator('iframe[title="HTML preview"][srcdoc*="Staged edit"]').waitFor();
});
