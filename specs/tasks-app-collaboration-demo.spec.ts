import { expect, type Page } from "@playwright/test";
import { mintProjectAppSession } from "../apps/auth/src/server/project-app-session.ts";
import { test } from "./test-support/test.ts";

const APP_URL = "https://tasks--task-demo.iterate.app";
const GITHUB_API_URL = "https://api.github.com/repos/mmkal/iterate-tasks-demo";
const PROJECT_ID = "prj_958f07c0fbb8428693364d55977b24ea";
const TYPING_DELAY_MS = 20;
const JONAS = {
  email: "jonas@nustom.com",
  name: "Jonas Templestein",
  sub: "fneMoWKAliTP1vVIDDOYEdTW4kqa5Gmr",
};
const MISHA = {
  email: "misha@nustom.com",
  name: "Misha Kaletsky",
  sub: "pliGdNxwLcWDq2azYfk7UzDNayZGkaIz",
};

// Deliberately opt-in: this is a disposable demo against shared production
// state, not part of the product-spec catalogue run by ordinary CI. Tracked in
// tasks/complete/2026-07-21-tasks-app-collaboration-demo.md.
test("demo the tasks app from checkout through collaboration and GitHub", async ({
  browser,
  page,
}) => {
  test.skip(process.env.TASKS_APP_DEMO !== "1", "Run explicitly against the task-demo app.");

  await signIn(page, JONAS);

  await using collaboratorContext = await browser.newContext({
    viewport: { height: 900, width: 1280 },
  });
  const collaboratorPage = await collaboratorContext.newPage();
  await signIn(collaboratorPage, MISHA);

  page.videoMode?.setStartTime();
  await page.bringToFront();
  await page.getByRole("main").getByRole("button", { name: "New checkout" }).click();
  await page.getByRole("heading", { name: "Todo" }).waitFor();
  const checkoutUrl = page.url();
  if (!checkoutUrl.startsWith(`${APP_URL}/c/`)) throw new Error("Checkout URL was not created.");

  await createTask(page, {
    description: "Two metres wide, one metre deep.",
    title: "Dig the first hole",
  });
  await createTask(page, {
    description: "Keep it three metres from the first.",
    title: "Dig the second hole",
  });

  await moveTaskToInProgress(page, "Dig the first hole");

  await collaboratorPage.goto(checkoutUrl);
  await rewriteTask(collaboratorPage, {
    description: "Keep it three metres from the first.",
    state: "in-review",
    title: "Dig the second hole",
  });

  // The primary page stays on-screen while Misha changes the shared checkout.
  // Matching the new state before moving it again proves the update arrived.
  await page.getByRole("button", { name: /Dig the second hole/ }).click({ timeout: 10_000 });
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Task state"]')?.textContent?.includes("In review"),
    undefined,
    { timeout: 10_000 },
  );
  await page.getByRole("combobox", { name: "Task state" }).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Close" }).click();

  const commitMessage = "Dig two holes together";
  await page.getByRole("button", { name: /^Commit \(\d+\)/ }).click();
  await page.getByPlaceholder("Commit message").type(commitMessage, {
    delay: TYPING_DELAY_MS,
    timeout: 5_000,
  });
  await page.getByRole("button", { exact: true, name: "Commit" }).click();

  // Mirroring to GitHub is asynchronous, so poll the public branch head with
  // a bounded external-system budget before navigating to its commit page.
  let commit = await latestGithubCommit();
  await expect
    .poll(async () => (commit = await latestGithubCommit()), { timeout: 30_000 })
    .toMatchObject({ message: commitMessage });
  await page.goto(commit.htmlUrl);
  await page.getByText(commitMessage, { exact: true }).waitFor({ timeout: 10_000 });
  // Presentation hold: leave a readable GitHub frame for video-mode's final
  // freeze instead of capturing Chromium's white cross-origin transition.
  await page.waitForTimeout(1_000);
  page.videoMode?.setEndTime();
});

async function createTask(page: Page, input: { description: string; title: string }) {
  await page.getByRole("button", { name: "New task" }).first().click();
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  const markdown = taskMarkdown({ ...input, state: "todo" });
  await typeIntoCodeMirror(page, markdown);
  await replaceCodeMirrorContents(page, markdown);
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: new RegExp(input.title) }).waitFor();
}

async function moveTaskToInProgress(page: Page, title: string) {
  await page.getByRole("button", { name: new RegExp(title) }).click({ timeout: 10_000 });
  await page.getByRole("combobox", { name: "Task state" }).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Close" }).click();
}

async function rewriteTask(
  page: Page,
  input: { description: string; state: string; title: string },
) {
  await page.getByRole("button", { name: new RegExp(input.title) }).click({ timeout: 10_000 });
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  const markdown = taskMarkdown(input);
  await typeIntoCodeMirror(page, markdown);
  await replaceCodeMirrorContents(page, markdown);
  await page.getByRole("button", { name: "Close" }).click();
}

async function typeIntoCodeMirror(page: Page, text: string) {
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(line, { delay: TYPING_DELAY_MS });
    if (index < lines.length - 1) await page.keyboard.press("Enter");
  }
}

async function replaceCodeMirrorContents(page: Page, text: string) {
  // CodeMirror visibly auto-indents the keystroke pass. Normalize the saved
  // document after the demonstration so the YAML remains canonical.
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
}

function taskMarkdown(input: { description: string; state: string; title: string }) {
  return [
    "---",
    `state: ${input.state}`,
    "author: jonas@nustom.com",
    "tags:",
    "  - groundwork",
    "---",
    "",
    `# ${input.title}`,
    "",
    input.description,
  ].join("\n");
}

async function latestGithubCommit() {
  const response = await fetch(`${GITHUB_API_URL}/commits/main`, {
    headers: { "cache-control": "no-cache" },
  });
  if (!response.ok) {
    return { htmlUrl: "", message: `GitHub returned ${response.status}.` };
  }
  const commit = (await response.json()) as {
    commit: { message: string };
    html_url: string;
  };
  return { htmlUrl: commit.html_url, message: commit.commit.message };
}

async function signIn(page: Page, identity: { email: string; name: string; sub: string }) {
  const session = await mintProjectAppSession(
    {
      audience: APP_URL,
      email: identity.email,
      name: identity.name,
      projectId: PROJECT_ID,
      userId: identity.sub,
    },
    {
      secret: requiredEnvironmentVariable("APP_CONFIG_PROJECT_APP_SESSION_SECRET"),
      userCanAccessProject: async ({ projectId, userId }) =>
        projectId === PROJECT_ID && userId === identity.sub,
    },
  );
  if (!session) throw new Error(`Could not mint the project session for ${identity.email}.`);
  await page.context().addCookies([
    {
      httpOnly: true,
      name: "iterate-project-auth",
      sameSite: "Strict",
      secure: true,
      url: APP_URL,
      value: session.token,
    },
  ]);
  await page.goto(APP_URL);
  await page.getByRole("button", { name: "New checkout" }).waitFor();
}

function requiredEnvironmentVariable(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the tasks app demo.`);
  return value;
}
