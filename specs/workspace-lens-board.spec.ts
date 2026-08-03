import { spinnerWaiter } from "middlewright";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import {
  signUpWithEmailOtp,
  startEmailOtpSignIn,
  uniqueSignupEmail,
} from "./test-support/email-otp-signup.ts";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

/**
 * PR #2375 demo recording — the whole jam-flow, against any OS deployment:
 *
 *   1. Ask an agent in a project to write five jokes into a file and share
 *      a link for feedback.
 *   2. Give feedback in the workspace document editor (the docs lens).
 *   3. Tell the agent to incorporate the feedback and create 5 tasks in
 *      /repos/config, and send a task-board link.
 *   4. See the tasks on the board — a GUEST lens on the agent's workspace.
 *
 * Opt-in only — skipped everywhere else, including the preview lane. Agent
 * turns are real LLM turns, so waits are generous — video mode speeds the
 * dead air away. Against a preview slot N:
 *
 *   DEMO_RECORDING=1 VIDEO_MODE=1 DOPPLER_CONFIG=preview_N \
 *   APP_CONFIG_BASE_URL=https://os.iterate-preview-N.com \
 *   TASKS_APP_ORIGIN=https://<your-tasks-vessel-or-tunnel> \
 *   pnpm spec -g "workspace lens board demo"
 *
 * The spec signs up a fresh member/org/project through the real email-OTP
 * lane, so it needs no standing project. TASKS_APP_ORIGIN must be a tasks
 * vessel that dials THIS deployment (see tasksOrigin below) — previews have
 * docs vessels in the envs.ts fleet but no tasks ones.
 */

test("workspace lens board demo", async ({ baseURL, page }, testInfo) => {
  // NEVER in CI: this is a demo RECORDING, not a test. It burns real LLM
  // turns and takes many minutes, so the preview lane must not pick it up.
  test.skip(
    process.env.DEMO_RECORDING !== "1",
    "demo recording — run locally with DEMO_RECORDING=1",
  );
  test.setTimeout(900_000);

  // A fresh member, organization, and project through the real email-OTP
  // signup lane (fixed code 424242 for +test@nustom.com outside production) —
  // no standing project to depend on, every run starts clean.
  test.skip(
    !(await startEmailOtpSignIn(page, testInfo)),
    "Email OTP sign-in is disabled for this deployment.",
  );
  const slug = uniqueFixtureSlug("lens-demo");
  await signUpWithEmailOtp(page, {
    email: uniqueSignupEmail("lens-demo"),
    projectSlug: slug,
    testInfo,
  });
  // First-run onboarding lands in the project behind an unmarked skeleton —
  // wait with spinner-waiter disabled, as signup.spec.ts does.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 });
  });

  // The seeded config worker proxies its docs/tasks branches at the PROD
  // vessels, and a vessel authenticates by dialing its own OS_BASE_URL — a
  // preview project's session means nothing to prod os. Point both origin
  // knobs at vessels that dial the deployment under test.
  using itx = await connectAdminItx(baseURL!);
  using project = itx.projects.get(slug);
  await project.kv.set("docs-app-origin", docsOrigin(baseURL!));
  await project.kv.set("tasks-app-origin", tasksOrigin(baseURL!));

  await page.goto(`/projects/${slug}`);

  // 1. Ask a fresh agent for five jokes and a review link.
  const composer = page.getByRole("textbox", { name: "Message a new agent" });
  await composer.waitFor({ timeout: 60_000 });
  // The demo is the jam flow, not account provisioning — start the recording
  // here, after signup and knob setup.
  page.videoMode?.setStartTime();
  // "your own workspace" on purpose: agents sometimes echo a workspace path
  // from earlier context instead of the one in their own boot context.
  await composer.fill(
    "write 5 jokes into a markdown file in YOUR OWN workspace (the workspace path from your context) and send me a docs link for feedback",
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const docsLink = page.locator(`a[href*="docs--${slug}"]`).first();
  await waitForAgentReply(docsLink, "a docs review link");
  const threadUrl = page.url();
  const docsHref = await docsLink.getAttribute("href");
  if (docsHref === null) throw new Error("the agent's reply carried no docs link");

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
    'thanks — incorporate my feedback in jokes.md, then create 5 task files under tasks/ in /repos/config in your workspace (one per joke, do NOT commit). Then send me a board link minted with itx.worker.tasks.link({ workspace: <your workspace>, repo: "/repos/config" }) so I can review them.',
  );
  await page.getByRole("button", { name: "Send message" }).click();
  // A real board deep link, not the bare app URL: the agent occasionally
  // pastes the app root, which lands on the workspace picker.
  const boardLink = page.locator(`a[href*="tasks--${slug}"][href*="workspace="]`).first();
  await waitForAgentReply(boardLink, "a task board link");
  const boardHref = await boardLink.getAttribute("href");
  if (boardHref === null) throw new Error("the agent's reply carried no board link");

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

/** Same derivation as seeded-apps.spec.ts: the envs.ts docs fleet has one
 * vessel per preview slot, each dialing its slot's OS. */
function docsOrigin(baseURL: string): string {
  const override = process.env.DOCS_APP_ORIGIN?.trim();
  if (override) return override.replace(/\/+$/, "");
  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(new URL(baseURL).hostname);
  if (previewMatch) {
    return `https://docs-preview-${previewMatch[1]}.iterate-dev-preview.workers.dev`;
  }
  if (new URL(baseURL).hostname === "os.iterate.com") return "https://docs.iterate.workers.dev";
  throw new Error("DOCS_APP_ORIGIN is required when recording outside prod/preview.");
}

/** Unlike docs, tasks has no per-preview vessels in the envs.ts fleet — the
 * deployed vessel dials prod os only. Against a preview, run the vessel
 * yourself against that deployment (apps/tasks dev with
 * OS_BASE_URL=<preview os> behind a captun tunnel) and pass its public
 * origin as TASKS_APP_ORIGIN. */
function tasksOrigin(baseURL: string): string {
  const override = process.env.TASKS_APP_ORIGIN?.trim();
  if (override) return override.replace(/\/+$/, "");
  if (new URL(baseURL).hostname === "os.iterate.com") return "https://tasks.iterate.workers.dev";
  throw new Error(
    "TASKS_APP_ORIGIN is required when recording outside os.iterate.com — no tasks vessel is deployed for previews.",
  );
}
