import { test } from "./test-support/test.ts";

/**
 * PR #2375 demo recording — the whole jam-flow, live on preview-9:
 *
 *   1. Ask an agent in a project to write five jokes into a file and share
 *      a link for feedback.
 *   2. Give feedback in the workspace document editor (the docs lens).
 *   3. Tell the agent to incorporate the feedback and create 5 tasks in
 *      /repos/config, and send a task-board link.
 *   4. See the tasks on the board — a GUEST lens on the agent's workspace.
 *
 * Opt-in only — `DEMO_RECORDING=1 VIDEO_MODE=1 pnpm spec -g "workspace lens
 * board demo"` against preview-9 (the lens-demo-live project, with its docs
 * vessel knob pointed at a developer tunnel). Skipped everywhere else,
 * including the preview lane. Agent turns are real LLM turns, so waits are
 * generous — video mode speeds the dead air away.
 */
const OS_PROJECT_URL = "https://os.iterate-preview-9.com/projects/lens-demo-live";

test("workspace lens board demo", async ({ page }) => {
  // NEVER in CI: this is a demo RECORDING, not a test. It drives a standing
  // preview-9 project whose docs vessel is a developer's tunnel, so the
  // preview lane must not pick it up just because it holds slot 9.
  test.skip(
    process.env.DEMO_RECORDING !== "1",
    "demo recording — run locally with DEMO_RECORDING=1",
  );
  test.setTimeout(900_000);

  // Sign in as the standing test member through the real email-OTP lane
  // (fixed code 424242 for +test@nustom.com outside production). The member
  // already has the org and project, so onboarding does not appear.
  await page.goto("https://os.iterate-preview-9.com/api/iterate-auth/login?login_hint=email");
  await page.getByTestId("email-input").fill("demo2+test@nustom.com");
  await page.getByTestId("email-submit-button").click();
  await page.getByTestId("email-otp-input").fill("424242");
  await page.getByTestId("email-verify-button").click({ timeout: 15_000 });
  // The OAuth hop lands back on OS; wait for the signed-in shell before
  // navigating on, or the in-flight redirect aborts the next goto.
  await page.getByRole("button", { name: "Toggle Sidebar" }).waitFor({ timeout: 90_000 });
  await page.goto(OS_PROJECT_URL);

  // 1. Ask a fresh agent for five jokes and a review link.
  const composer = page.getByRole("textbox", { name: "Message a new agent" });
  await composer.waitFor({ timeout: 60_000 });
  // "your own workspace" on purpose: agents sometimes echo a workspace path
  // from earlier context instead of the one in their own boot context.
  await composer.fill(
    "write 5 jokes into a markdown file in YOUR OWN workspace (the workspace path from your context) and send me a docs link for feedback",
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const docsLink = page.locator('a[href*="docs--lens-demo-live"]').first();
  await waitForAgentReply(docsLink, "a docs review link");
  const threadUrl = page.url();
  const docsHref = await docsLink.getAttribute("href");
  if (!docsHref) throw new Error("the agent's reply carried no docs link");

  // 2. Open the review link and leave feedback in the document editor.
  await page.goto(docsHref);
  await passProjectGate(page);
  const comment = page.getByRole("textbox", { name: /Comment on the entire document/ });
  await comment.waitFor({ timeout: 60_000 });
  // Comments are whole-file transforms routed through the live document, so
  // they refuse until the collab session has attached ("the editor is still
  // connecting"). Wait for live, then retry the submit until it lands.
  await page.getByText(/^live · v/).waitFor({ timeout: 60_000 });
  const commentCount = page.getByRole("button", { name: /Comments \(\d+\)/ });
  for (let attempt = 0; attempt < 10 && !(await commentCount.isVisible()); attempt++) {
    await comment.fill(
      "Joke 3 is too niche — swap it for something broader. The rest are keepers!",
    );
    await page.getByRole("button", { name: "Add document comment" }).click();
    await commentCount.or(page.getByText(/still connecting/)).waitFor({ timeout: 10_000 });
  }
  await commentCount.waitFor({ timeout: 30_000 });

  // 3. Tell the agent to incorporate the feedback and stage tasks.
  await page.goto(threadUrl);
  const reply = page.getByRole("textbox", { name: "Message this agent" });
  await reply.waitFor({ timeout: 60_000 });
  await reply.fill(
    'thanks — incorporate my feedback in jokes.md, then create 5 task files under tasks/ in /repos/config in your workspace (one per joke, do NOT commit). Then send me a board link minted with itx.worker.docs.link({ workspace: <your workspace>, repo: "/repos/config" }) so I can review them.',
  );
  await page.getByRole("button", { name: "Send message" }).click();
  // A real board deep link, not the bare app URL: the agent occasionally
  // pastes the app root, which lands on the workspace picker.
  const boardLink = page.locator('a[href*="docs--lens-demo-live"][href*="/w?"]').first();
  await waitForAgentReply(boardLink, "a task board link");
  const boardHref = await boardLink.getAttribute("href");
  if (!boardHref) throw new Error("the agent's reply carried no board link");

  // 4. The board: a GUEST lens on the agent's workspace — hierarchy
  // breadcrumbs, the agent's uncommitted joke tasks, no Commit control.
  await page.goto(boardHref);
  await passProjectGate(page);
  await page.getByText("GUEST").waitFor({ timeout: 60_000 });
  await page.getByText("/repos/config").first().waitFor();
  await page.getByRole("button", { name: /joke/i }).first().click();
  await page.getByRole("combobox", { name: "Task state" }).waitFor({ timeout: 30_000 });
});

/**
 * An agent turn is a real LLM turn — minutes, not seconds. Wait in bounded
 * slices rather than one oversized inline timeout: the e2e budget ladder
 * caps any single inline `timeout:` at the heavy-test ceiling, since that
 * value becomes the preview lane's worst-case tail.
 */
async function waitForAgentReply(
  locator: import("@playwright/test").Locator,
  what: string,
): Promise<void> {
  for (let slice = 0; slice < 4; slice++) {
    try {
      await locator.waitFor({ timeout: 120_000 });
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
    await gate.click({ timeout: 10_000 });
  } catch {
    // already authorized on this host
  }
}
