// The Dash's repo IDE (apps/dash/src/routes/_auth/projects/$slug/repos.$.tsx, the `RepoIde` of
// packages/ui): a project's repos, one opened as a file tree beside an editor. Edits stay in the
// browser until Commit sends them as one commit; the repo's history, its commits from anywhere, and
// the diff of what changed are all on the page.
import { expect } from "@playwright/test";
import { test } from "../../helpers/test.ts";

test("a repo opens as an IDE: edit a file and see its diff, make a new file and preview it, commit both, read the history, and follow a commit made elsewhere", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("dash");
  await using fixture = await helpers.createFixture("repo-ide", { app: baseURL });
  const config = fixture.itx.repos.get("/repos/config");

  await test.step("open the project's config repo from the Repos page; a commit made elsewhere reaches the open page", async () => {
    // the project's config repo is seeded as the project is made: its first commit lands in the
    // background (the fixture returns before it)
    await expect
      .poll(() => config.tip().catch(() => null), { timeout: 30_000 }) // timeout: the seed is a background push no spinnerWaiter UI can show
      .not.toBeNull();
    await page.getByRole("link", { name: "Repos", exact: true }).click();
    await page.getByRole("link", { name: "/repos/config", exact: true }).click();
    // once it is open, a commit to it from anywhere reaches the page
    await page.getByRole("treeitem", { name: "AGENTS.md", exact: true }).waitFor();
    await config.commitFiles({
      message: "docs: a first guide",
      parent: await config.tip(),
      changes: [{ path: "guide.md", content: "# Guide\n\nFirst draft.\n" }],
    });
    await page.getByRole("treeitem", { name: "guide.md", exact: true }).waitFor();
  });

  await test.step("edit a file: the tree marks it, the editor shows the diff against the last commit", async () => {
    await page.getByRole("treeitem", { name: "guide.md", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "guide.md", exact: true });
    await editor.click();
    await editor.press("ControlOrMeta+End");
    await editor.pressSequentially("\nSecond line from the IDE.\n");
    await page.getByRole("button", { name: "Diff", exact: true }).click();
    await page.getByText("(Working Tree)", { exact: true }).waitFor();
    await page.getByText("Second line from the IDE.", { exact: true }).waitFor();
  });

  await test.step("make a new markdown file and read it rendered", async () => {
    await page.getByRole("button", { name: "New file", exact: true }).click();
    await page.keyboard.type("notes.md");
    await page.keyboard.press("Enter");
    const editor = page.getByRole("textbox", { name: "notes.md", exact: true });
    await editor.click();
    await editor.pressSequentially("# Notes from the IDE");
    await page.getByRole("tab", { name: "Preview", exact: true }).click();
    await page.getByRole("heading", { name: "Notes from the IDE", exact: true }).waitFor();
  });

  await test.step("commit both from Source control: one commit, in the repo", async () => {
    await page.getByRole("button", { name: "Source control", exact: true }).click();
    await page.getByRole("textbox", { name: "Commit message" }).fill("docs: notes from the IDE");
    await page.getByRole("button", { name: "Commit 2", exact: true }).click();
    await page.getByText(/^Committed 2 file\(s\)/).waitFor();
    await page.getByText("No changes.", { exact: true }).waitFor();
    await expect.poll(() => config.readFile("notes.md")).toBe("# Notes from the IDE");
    await expect.poll(() => config.readFile("guide.md")).toContain("Second line from the IDE.");
  });

  await test.step("History lists the commit; its file opens as a readonly diff against the parent", async () => {
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.getByText("docs: notes from the IDE", { exact: true }).first().click();
    await page.getByRole("button", { name: /^M\s*guide\.md$/ }).click();
    await page.getByText("Second line from the IDE.", { exact: true }).waitFor();
  });

  await test.step("a commit made elsewhere reaches the open page", async () => {
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await config.commitFiles({
      message: "from an agent",
      parent: await config.tip(),
      changes: [{ path: "from-an-agent.md", content: "# Hello\n" }],
    });
    await page.getByRole("treeitem", { name: "from-an-agent.md", exact: true }).waitFor();
  });

  await test.step("make a new, empty repo from the Repos page and commit its first file", async () => {
    // the sidebar's link, not the breadcrumb's current page
    await page.getByRole("link", { name: "Repos", exact: true }).and(page.locator("a")).click();
    await page.getByRole("textbox", { name: "New repo name" }).fill("scratch");
    await page.getByRole("button", { name: "New repo", exact: true }).click();
    await page.getByRole("button", { name: "New file", exact: true }).click();
    await page.keyboard.type("hello.md");
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "hello.md", exact: true }).pressSequentially("# hello");
    await page.getByRole("button", { name: "Source control", exact: true }).click();
    await page.getByRole("textbox", { name: "Commit message" }).fill("first commit");
    await page.getByRole("button", { name: "Commit 1", exact: true }).click();
    await page.getByText(/^Committed 1 file\(s\)/).waitFor();
    await expect
      .poll(() => fixture.itx.repos.get("/repos/scratch").readFile("hello.md"))
      .toBe("# hello");
  });
});
