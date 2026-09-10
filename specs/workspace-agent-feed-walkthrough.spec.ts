import { test } from "./test-support/test.ts";

/**
 * Demo recording — a workspace's agent, in Docs, on a preview:
 *
 *   1. Sign in through the preview's one-click test login.
 *   2. Docs: New workspace (a path under /agents/), a first file of my own.
 *   3. The toolbar's Agent button swaps the comments column for the
 *      workspace's agent feed — the same rows the OS renders — and births
 *      the agent on the workspace's own stream.
 *   4. Ask it to read the file and leave one document comment; watch the
 *      turn run in the feed, then the reply.
 *   5. Back to Comments: the agent's comment sits in the rail.
 *
 * Opt-in only — `DEMO_RECORDING=1 VIDEO_MODE=1 DEMO_PREVIEW_SLOT=<n>
 * DEMO_PROJECT=pr<N> pnpm spec -g "workspace agent feed walkthrough"`.
 * Skipped everywhere else, including the preview e2e run: the agent's turn
 * is a real model turn, so the waits are generous.
 */
test("workspace agent feed walkthrough", async ({ page }) => {
  test.skip(
    process.env.DEMO_RECORDING !== "1",
    "demo recording — run locally with DEMO_RECORDING=1",
  );
  test.setTimeout(900_000);
  const slot = process.env.DEMO_PREVIEW_SLOT ?? "";
  const project = process.env.DEMO_PROJECT ?? "";
  if (slot === "" || project === "") throw new Error("set DEMO_PREVIEW_SLOT and DEMO_PROJECT");
  const osHost = `https://os.iterate-preview-${slot}.com`;
  const docsHost = `https://docs--${project}.iterate-preview-${slot}.app`;

  // 1. One-click test login on the auth origin (creates the pr<N> user +
  //    project if needed; a same-origin return keeps it independent of the
  //    slot's registered relying parties), then the OS relying-party login
  //    completes silently against that session.
  await page.goto(
    `https://auth.iterate-preview-${slot}.com/test-login?email=${project}%2Btest%40nustom.com&project=${project}&return_to=%2F`,
  );
  await page.waitForLoadState("networkidle");
  await page.goto(`${osHost}/api/iterate-auth/login`);
  await page.getByRole("button", { name: "Toggle Sidebar" }).waitFor({ timeout: 90_000 }); // timeout: cross-server OAuth hop + cold preview shell — past the spinner-waiter's 30s ceiling

  // 2. Docs: a new workspace from the sidebar, then a first file of my own.
  await page.goto(`${docsHost}/`);
  await passProjectGate(page);
  await page
    .getByRole("button", { name: /^\/agents\// })
    .or(page.getByText("No workspaces yet"))
    .first()
    .waitFor({ timeout: 30_000 }); // timeout: the auth callback redirect on the preview before the home renders — no loading UI for the spinner-waiter in between
  const sidebar = page.locator('[data-slot="sidebar"]');
  await sidebar.getByRole("button", { name: "New workspace" }).click();
  await sidebar.getByRole("button", { name: "Create" }).click();
  await page.locator('[data-item-path^="repos/config"]').first().waitFor({ timeout: 60_000 }); // timeout: docs vessel cold load + first status on the preview — past the spinner-waiter's 30s ceiling
  await page.getByTitle("New file").click();
  await page.locator("[data-item-rename-input]").fill("plan");
  await page.locator("[data-item-rename-input]").press("Enter");
  await page.locator('[data-item-path$="plan.md"]').waitFor({ timeout: 15_000 }); // timeout: the row lands on the re-list after the write — no loading UI for the spinner-waiter in between
  await page.getByText(/^live · v/).waitFor({ timeout: 60_000 }); // timeout: collab-session attach on the preview — past the spinner-waiter's 30s ceiling
  await page.locator(".cm-content").first().click();
  await page.keyboard.type(
    "# Launch plan\n\nShip the docs agent feed this week. Announce it on Friday.\n",
  );

  // 3. The Agent pane: the workspace's own agent, born on first open.
  await page.getByRole("button", { name: "Agent" }).click();
  const pane = page.getByTestId("agent-feed-pane");
  await pane.waitFor();
  const composer = pane.getByRole("textbox", { name: "Message the agent" });
  await composer.waitFor({ timeout: 90_000 }); // timeout: birth + history read through the vessel on a cold preview — past the spinner-waiter's 30s ceiling
  await pane.getByText(/^(live|working)$/).waitFor({ timeout: 60_000 }); // timeout: the publications connection opens after history — no loading UI for the spinner-waiter in between

  // 4. Ask for one document comment; the feed shows the turn, then the reply.
  await composer.fill(
    "Read plan.md in this workspace and leave ONE document comment suggesting a concrete improvement, then tell me here when it is in.",
  );
  await pane.getByRole("button", { name: "Send message" }).click();
  const userRow = pane.locator('[data-testid="agent-feed-message"][data-kind="user"]').first();
  await userRow.waitFor({ timeout: 60_000 }); // timeout: the feed facet publishes the user message on the next commit — no loading UI for the spinner-waiter in between
  const reply = pane.locator('[data-testid="agent-feed-message"][data-kind="assistant"]').first();
  await waitForAgentReply(reply, "a chat reply");

  // 5. Back to Comments: the agent's comment is in the rail.
  await page.getByRole("button", { name: "Agent" }).click();
  await page
    .getByLabel("Document comments")
    .locator("article")
    .first()
    .waitFor({ timeout: 60_000 }); // timeout: the comment lands through the live document — no loading UI for the spinner-waiter in between
});

/**
 * A real model turn on a freshly born agent: its first turn waits up to a
 * minute for the config worker, then the model. Bounded slices keep every
 * inline timeout under the lane's heavy-test ceiling while the live activity
 * row (product UI, not a spinner) plays in the feed.
 */
async function waitForAgentReply(
  locator: import("@playwright/test").Locator,
  what: string,
): Promise<void> {
  for (let slice = 0; slice < 3; slice++) {
    try {
      await locator.waitFor({ timeout: 120_000 }); // timeout: one bounded model-turn slice (see docstring) — the live activity row is product UI the spinner-waiter cannot treat as a spinner
      return;
    } catch {
      // keep waiting — the turn is still running
    }
  }
  throw new Error(`the agent never replied with ${what}`);
}

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
