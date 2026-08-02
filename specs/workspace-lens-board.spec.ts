import { expect } from "@playwright/test";
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
 * Run with VIDEO_MODE=1 for the rendered walkthrough. Environment-pinned on
 * purpose (the lens-demo-live project exists on preview-9 with the tasks
 * vessel knob set); skipped everywhere else. Agent turns are real LLM turns,
 * so waits are generous — video mode speeds the dead air away.
 */
const OS_PROJECT_URL = "https://os.iterate-preview-9.com/projects/lens-demo-live";

test("workspace lens board demo", async ({ page }) => {
  test.skip(
    !(process.env.APP_CONFIG_BASE_URL ?? "").includes("preview-9"),
    "demo spec for the preview-9 lens-demo-live project only",
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
  // The OAuth hop lands back on OS; let it settle before navigating on, or
  // the in-flight redirect aborts the next goto.
  await page.waitForURL(/os\.iterate-preview-9\.com\/projects\//, { timeout: 90_000 });
  await page.goto(OS_PROJECT_URL);

  // 1. Ask a fresh agent for five jokes and a review link.
  const composer = page.getByRole("textbox", { name: "Message a new agent" });
  await composer.waitFor({ timeout: 60_000 });
  await composer.fill("write 5 jokes in a markdown file and send me a link for feedback");
  await page.getByRole("button", { name: "Send message" }).click();
  const docsLink = page.locator('a[href*="docs--lens-demo-live"]').first();
  await docsLink.waitFor({ timeout: 300_000 });
  const threadUrl = page.url();
  const docsHref = await docsLink.getAttribute("href");
  expect(docsHref).toBeTruthy();

  // 2. Open the review link and leave feedback in the document editor.
  await page.goto(docsHref!);
  await passProjectGate(page);
  const comment = page.getByRole("textbox", { name: /Comment on the entire document/ });
  await comment.waitFor({ timeout: 60_000 });
  // Comments are whole-file transforms routed through the live document, so
  // they refuse until the collab session has attached ("the editor is still
  // connecting"). Wait for live, then retry the submit until it lands.
  await page.getByText(/^live · v/).waitFor({ timeout: 60_000 });
  await expect(async () => {
    await comment.fill(
      "Joke 3 is too niche — swap it for something broader. The rest are keepers!",
    );
    await page.getByRole("button", { name: "Add document comment" }).click();
    await page.getByRole("button", { name: /Comments \(\d+\)/ }).waitFor({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });

  // 3. Tell the agent to incorporate the feedback and stage tasks.
  await page.goto(threadUrl);
  const reply = page.getByRole("textbox", { name: "Message this agent" });
  await reply.waitFor({ timeout: 60_000 });
  await reply.fill(
    "thanks — incorporate my feedback in jokes.md, then create 5 task files under tasks/ in /repos/config in your workspace (one per joke, do NOT commit) and send me a task board link to review them",
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const boardLink = page.locator('a[href*="tasks--lens-demo-live"]').first();
  await boardLink.waitFor({ timeout: 420_000 });
  const boardHref = await boardLink.getAttribute("href");
  expect(boardHref).toBeTruthy();

  // 4. The board: a GUEST lens on the agent's workspace — hierarchy
  // breadcrumbs, the agent's uncommitted joke tasks, no Commit control.
  await page.goto(boardHref!);
  await passProjectGate(page);
  await page.getByText("GUEST").waitFor({ timeout: 60_000 });
  await page.getByText("/repos/config").first().waitFor();
  await page.getByRole("button", { name: /joke/i }).first().click();
  await page.getByRole("combobox", { name: "Task state" }).waitFor({ timeout: 30_000 });
});

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
