import { openRepoTreeFile } from "./test-support/repo-tree.ts";
import { test } from "./test-support/test.ts";

/**
 * PR #2611 demo recording — the Docs app as a workspace app, on a preview:
 *
 *   1. Sign in through the preview's one-click test login.
 *   2. Docs: mint a scratch workspace; the tree shows the config repo
 *      mounted at repos/config beside the workspace's own directory.
 *   3. Edit the starter note (live collab editor), open a repo file
 *      read-only, watch the Commit control arm for the config mount.
 *   4. Change a repo file through the note's neighbour, toggle the diff
 *      against HEAD.
 *   5. OS: the same workspace at /projects/<slug>/workspaces/<path> —
 *      the shared tree, file view, and commit controls over the live stub.
 *
 * Opt-in only — `DEMO_RECORDING=1 VIDEO_MODE=1 DEMO_PREVIEW_SLOT=<n>
 * DEMO_PROJECT=pr2611 pnpm spec -g "workspace tree walkthrough"`. Skipped
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

  // 2. Docs: a fresh scratch workspace, the whole workspace in the tree.
  await page.goto(`${docsHost}/`);
  await passProjectGate(page);
  await page.getByRole("button", { name: "New workspace" }).click();
  await page.getByRole("heading", { name: /notes\.md$/ }).waitFor({ timeout: 60_000 }); // timeout: docs vessel cold load + collab attach on the preview — past the spinner-waiter's 30s ceiling
  // Tree rows carry their path; the compacted mount row is repos/config.
  await page.locator('[data-item-path="repos/config"]').waitFor();
  await page.locator('[data-item-path^="workspaces/scratch/"]').first().waitFor();

  // 3. Type into the starter note; the own directory shows the addition,
  //    and a repo file opens read-only.
  await page.getByText(/^live · v/).waitFor({ timeout: 60_000 }); // timeout: collab-session attach on the preview — past the spinner-waiter's 30s ceiling
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("A workspace holds every repo, and my own files beside them.");
  await openRepoTreeFile(page, "repos/config/worker.ts");
  await page.getByRole("heading", { name: /worker\.ts$/ }).waitFor();

  // 4. Add a file to the config mount from the tree: the mount's Commit
  //    control arms, and the diff toggle shows the change against HEAD.
  await page.locator('[data-item-path="repos/config"]').click({ button: "right" });
  await page.getByRole("button", { name: "New file" }).first().click();
  await page.keyboard.type("hello");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: /hello\.md$/ }).waitFor();
  await page.getByText(/^live · v/).waitFor({ timeout: 60_000 }); // timeout: a second collab attach on the preview — past the spinner-waiter's 30s ceiling
  await page.locator(".cm-content").first().click();
  await page.keyboard.type("# Hello from the workspace tree\n");
  await page.getByRole("button", { name: /^Commit/ }).waitFor();
  await page.getByRole("button", { name: "Show diff against HEAD" }).click();
  await page.getByText("against HEAD").waitFor();
  await page.getByRole("button", { name: "Show file" }).click();

  // 5. OS: the same workspace over the live stub — catalog, tree, file, diff.
  const workspacePath = new URL(page.url()).searchParams.get("workspace") ?? "";
  await page.goto(`${osHost}/projects/${project}/workspaces`);
  await page.getByRole("link", { name: workspacePath }).click();
  await openRepoTreeFile(page, "repos/config/hello.md");
  await page.getByRole("heading", { name: /hello\.md$/ }).waitFor();
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
