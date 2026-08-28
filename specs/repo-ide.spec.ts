import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";
import { openRepoTreeFile } from "./test-support/repo-tree.ts";

/**
 * The repos mini IDE golden path: a repo page is a small vscode — pierre file
 * tree, editable CodeMirror buffers, a git-shaped working tree (persisted in
 * the browser per HEAD commit), staging, an inline diff, and Commit flushing
 * through `repo.commitFiles`.
 */
test("edit, stage, inspect the Index, and commit through the repo IDE", async ({
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("repo-ide");

  // Repos are template-seeded on create, so the IDE opens onto real files.
  const project = await fixture.itx();
  await project.repos.get("/repos/ide").create({ type: "empty" });

  await page.goto(`/projects/${fixture.project.slug}/repos/ide`);

  // Open a seeded file from the tree (pierre renders rows in a shadow root;
  // playwright locators pierce it — target the exact path, the template also
  // ships an integrations/waitrose/README.md) and edit it.
  await openRepoTreeFile(page, "README.md");
  await page.locator(".cm-content").click();
  // Select-all + ArrowRight parks the cursor at the end of the document on
  // every platform (Cmd/Ctrl+End bindings differ between mac and linux).
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("\nAn uncommitted line.");
  await page.getByText("modified", { exact: true }).waitFor();

  // Dirtiness lives in localStorage keyed by HEAD oid: a reload keeps it.
  await page.reload();
  await page.getByText("modified", { exact: true }).waitFor();

  // The inline diff is the same editable buffer viewed against its baseline.
  await page.getByRole("button", { name: "Diff" }).click();
  await page.getByText("README.md (Working Tree)").waitFor();
  await page.getByRole("button", { name: "Diff" }).click();

  // Stage the file: it moves from Changes to Staged Changes, and Commit
  // narrows to "what's staged".
  await page.getByRole("button", { name: "Stage" }).click();
  await page.getByRole("button", { name: "Source control" }).click();
  await page.getByText("Staged Changes").waitFor();
  await page.getByRole("button", { name: "Commit 1 staged" }).waitFor();

  // Editing again after staging puts the file in BOTH sections.
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("\nA second, unstaged line.");
  await page.getByRole("button", { name: "README.md" }).nth(1).waitFor();

  // The staged row opens the readonly "(Index)" pseudo-file: locked, always
  // a diff, with Unstage and an escape back to the editable working tree.
  await page.getByRole("button", { name: "README.md" }).first().click();
  await page.getByText("README.md (Index)").waitFor();
  await page.getByRole("button", { name: "Open file" }).click();
  // Back on the editable working-tree file — Discard only exists there.
  await page.getByRole("button", { name: "Discard", exact: true }).waitFor();

  // Commit what's staged; the unstaged edit survives against the new HEAD.
  await page.getByPlaceholder("Commit message").fill("Stage-only commit");
  await page.getByRole("button", { name: "Commit 1 staged" }).click();
  await page.getByText(/Committed 1 file/).waitFor();
  // Only the unstaged edit remains: Commit widens back to "everything".
  await page.getByRole("button", { name: /^Commit 1$/ }).waitFor();
  await page.getByRole("button", { name: "README.md" }).waitFor();
});

test("discarding a new file confirms before permanently removing it", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("repo-ide-discard");

  const project = await fixture.itx();
  await project.repos.get("/repos/ide").create({ type: "empty" });

  await page.goto(`/projects/${fixture.project.slug}/repos/ide`);
  page.videoMode?.setStartTime();

  await page.getByTitle("New file").click();
  await page.locator("[data-item-rename-input]").fill("draft.md");
  await page.locator("[data-item-rename-input]").press("Enter");
  await page.locator(".cm-content").click();
  await page.keyboard.type("Content that has never been committed.");

  await page.getByRole("button", { name: "Source control" }).click();
  const discard = page.getByRole("button", { name: "Discard", exact: true });

  const cancelDialogPromise = page.waitForEvent("dialog");
  const cancelClickPromise = discard.click();
  const cancelDialog = await cancelDialogPromise;
  expect(cancelDialog.message()).toBe("Are you sure? You may not be able to recover this file");
  await cancelDialog.dismiss();
  await cancelClickPromise;
  await page.getByText("Content that has never been committed.").waitFor();

  const acceptDialogPromise = page.waitForEvent("dialog");
  const acceptClickPromise = discard.click();
  const acceptDialog = await acceptDialogPromise;
  expect(acceptDialog.message()).toBe("Are you sure? You may not be able to recover this file");
  await acceptDialog.accept();
  await acceptClickPromise;

  await page.getByText("No changes.").waitFor();
  expect(new URL(page.url()).searchParams.get("file")).toBeNull();
});
