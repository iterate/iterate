import { openRepoTreeFile } from "./test-support/repo-tree.ts";
import { test } from "./test-support/test.ts";

/**
 * Demo recording (PRs #2611, #2618) — the Docs app as a workspace app, on
 * a preview:
 *
 *   1. Sign in through the preview's one-click test login.
 *   2. Docs: the sidebar's New workspace item opens an inline form with a
 *      three-word name; Create lands on the workspace, whose tree shows
 *      the config repo mounted at repos/config beside its own directory.
 *   3. Add a first file of my own (live collab editor), open a repo file
 *      read-only.
 *   4. Edit a repo document; the config mount's Commit control arms;
 *      toggle the diff against HEAD.
 *   5. OS: the same workspace at /projects/<slug>/workspaces/<path> —
 *      the shared tree, file view, and commit controls over the live stub.
 *
 * Opt-in only — `DEMO_RECORDING=1 VIDEO_MODE=1 DEMO_PREVIEW_SLOT=<n>
 * DEMO_PROJECT=pr<N> pnpm spec -g "workspace tree walkthrough"`. Skipped
 * everywhere else, including the preview e2e run: it drives a slot whose
 * project has its docs-app-origin knob pointed at that slot's docs vessel.
 */
test("workspace tree walkthrough", async ({ page }) => {
  test.skip(
    process.env.DEMO_RECORDING !== "1",
    "demo recording — run locally with DEMO_RECORDING=1",
  );
  test.setTimeout(600_000);
  const slot = process.env.DEMO_PREVIEW_SLOT ?? "";
  const project = process.env.DEMO_PROJECT ?? "";
  if (slot === "" || project === "") throw new Error("set DEMO_PREVIEW_SLOT and DEMO_PROJECT");
  const osHost = `https://os.iterate-preview-${slot}.com`;
  const docsHost = `https://docs--${project}.iterate-preview-${slot}.app`;

  // 1. One-click test login: auth creates the pr<N> user + project if needed.
  await page.goto(
    `https://auth.iterate-preview-${slot}.com/test-login?email=${project}%2Btest%40nustom.com&project=${project}&return_to=${encodeURIComponent(`${osHost}/api/iterate-auth/login`)}`,
  );
  await page.getByRole("button", { name: "Toggle Sidebar" }).waitFor({ timeout: 90_000 }); // timeout: cross-server OAuth hop + cold preview shell — past the spinner-waiter's 30s ceiling

  // 2. Docs: a new workspace by name from the sidebar, the whole workspace
  //    in the tree.
  await page.goto(`${docsHost}/`);
  await passProjectGate(page);
  // The home is server-rendered with an EMPTY name in its own form; the
  // three-word suggestion (and its resolved path under it) appears on the
  // client after hydration. A click before then hits controls with no
  // handlers yet, so wait for that path before touching the sidebar.
  await page
    .getByText(/^\/workspaces\/[a-z]+-[a-z]+-[a-z]+$/)
    .first()
    .waitFor({ timeout: 30_000 }); // timeout: the auth callback redirect + hydration on the preview — no loading UI for the spinner-waiter in between
  const sidebar = page.locator('[data-slot="sidebar"]');
  await sidebar.getByRole("button", { name: "New workspace" }).click();
  await sidebar.getByRole("button", { name: "Create" }).click();
  await page.locator('[data-item-path^="repos/config"]').first().waitFor({ timeout: 60_000 }); // timeout: docs vessel cold load + first status on the preview — past the spinner-waiter's 30s ceiling
  // Tree rows carry their path (directories in pierre's trailing-slash form);
  // the compacted mount row comes first among everything under it.
  const configRow = page.locator('[data-item-path^="repos/config"]').first();
  await configRow.waitFor();
  await page.locator('[data-item-path^="workspaces/"]').first().waitFor();

  // 3. A first file of my own: New file typed at the tree's root lands in the
  //    workspace's own directory (".md" implied) and opens live; the own
  //    directory shows the addition, and a repo file opens read-only.
  await page.getByTitle("New file").click();
  await page.locator("[data-item-rename-input]").fill("notes");
  await page.locator("[data-item-rename-input]").press("Enter");
  await page.locator('[data-item-path$="notes.md"]').waitFor({ timeout: 15_000 }); // timeout: the row lands on the re-list after the write — no loading UI for the spinner-waiter in between
  await page.getByText(/^live · v/).waitFor({ timeout: 60_000 }); // timeout: collab-session attach on the preview — past the spinner-waiter's 30s ceiling
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("A workspace holds every repo, and my own files beside them.");
  await openRepoTreeFile(page, "repos/config/worker.ts");
  await page.getByRole("heading", { name: /worker\.ts$/ }).waitFor();

  // 4. Edit a repo document: the config mount's Commit control arms, and
  //    the diff toggle shows the change against HEAD.
  await openRepoTreeFile(page, "repos/config/AGENTS.md");
  await page.getByRole("heading", { name: /AGENTS\.md$/ }).waitFor();
  await page.getByText(/^live · v/).waitFor({ timeout: 60_000 }); // timeout: a second collab attach on the preview — past the spinner-waiter's 30s ceiling
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("\n\nEdited from the workspace tree.\n");
  await page.getByRole("button", { name: /^Commit/ }).waitFor({ timeout: 15_000 }); // timeout: the control arms on the next status poll (5s cadence) after the session flushes — no loading UI for the spinner-waiter in between
  await page.getByRole("button", { name: "Show diff against HEAD" }).click();
  await page.getByText("against HEAD").waitFor();
  await page.getByRole("button", { name: "Show file" }).click();

  // 5. OS: the same workspace over the live stub — catalog, tree, file, diff.
  const workspacePath = new URL(page.url()).searchParams.get("workspace") ?? "";
  await page.goto(`${osHost}/projects/${project}/workspaces`);
  await page.getByRole("link", { name: workspacePath }).click();
  // The tree header names the workspace once the route rendered; the mount
  // row follows once the first status lands (a loading row bridges both).
  await page.locator("span[title]", { hasText: workspacePath }).waitFor();
  await page.locator('[data-item-path^="repos/config"]').first().waitFor();
  await openRepoTreeFile(page, "repos/config/AGENTS.md");
  await page.getByRole("heading", { name: /AGENTS\.md$/ }).waitFor();
  await page.getByRole("button", { name: "Show diff against HEAD" }).click();
  await page.getByText("against HEAD").waitFor();
});

/** The project-member gate interstitial appears only when the project host
 * has no session cookie yet — click through when it does. */
async function passProjectGate(page: import("@playwright/test").Page): Promise<void> {
  const gate = page.getByRole("link", { name: "Continue with iterate" });
  try {
    await gate.click({ timeout: 10_000 }); // timeout: presence probe — the gate may legitimately never appear, nothing for the spinner-waiter to wait on
  } catch {
    // already authorized on this host
  }
}
