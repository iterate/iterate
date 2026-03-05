import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Page, expect } from "@playwright/test";
import { spinnerWaiter } from "./plugins/spinner-waiter.ts";
import { createOrganization, createProject, login, sidebarButton, test } from "./test-helpers.ts";

// Resolve the image tag to use for machine creation.
// Priority: SANDBOX_IMAGE_TAG -> DOCKER_DEFAULT_IMAGE -> FLY_DEFAULT_IMAGE.
function resolveImageTag(): string {
  if (process.env.SANDBOX_IMAGE_TAG) return process.env.SANDBOX_IMAGE_TAG;
  try {
    const dockerDefault = execSync("doppler run -- sh -c 'echo $DOCKER_DEFAULT_IMAGE'", {
      encoding: "utf-8",
    }).trim();
    if (dockerDefault) return dockerDefault;
    return execSync("doppler run -- sh -c 'echo $FLY_DEFAULT_IMAGE'", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

async function createMachineFromUi(page: Page, machineName: string, imageTag?: string) {
  await sidebarButton(page, "Machines").click();
  await page
    .getByRole("link", { name: "Create Machine" })
    .or(page.getByRole("button", { name: "Create Machine" }))
    .click();

  await page.getByPlaceholder("Machine name").fill(machineName);

  if (imageTag) {
    const imageInput = page.getByRole("textbox", {
      name: /iterate-sandbox:sha-<shortSha>|leave blank for default/i,
    });
    await imageInput.fill(imageTag);
  }

  await page.getByRole("button", { name: "Create" }).click();

  // Wait for the machine to appear in the list (may need a re-fetch cycle).
  const machineLink = page.getByRole("link", { name: machineName }).first();
  await machineLink.waitFor({ timeout: 30_000 });
  await machineLink.click();

  await spinnerWaiter.settings.run({ spinnerTimeout: 360_000 }, async () => {
    await page
      .locator("dd")
      .filter({ hasText: /^active$/ })
      .waitFor();
  });
}

/** Run a shell command on the machine via the "Run command" button on the detail page. */
async function runCommandOnMachine(page: Page, command: string): Promise<string> {
  await page.evaluate((cmd) => (window.prompt = () => cmd), command);
  await page.getByRole("button", { name: "Run command" }).click();
  const resultBlock = page.getByTestId("exec-command-result");
  await resultBlock.waitFor();
  return (await resultBlock.textContent()) ?? "";
}

test.describe("machine persistence", () => {
  test("~/.local/share/iterate file persists across machine replacement", async ({ page }) => {
    test.setTimeout(900_000);
    test.skip(
      process.env.MACHINE_PERSISTENCE_SPEC !== "1",
      "Set MACHINE_PERSISTENCE_SPEC=1 to run machine persistence specs",
    );

    const imageTag = resolveImageTag();
    const now = Date.now();
    const testEmail = `persist-files-${now}+test@nustom.com`;
    const machineA = `Persist A ${now}`;
    const machineB = `Persist B ${now}`;
    const marker = `persist-marker-${now}`;
    const markerPath = "~/.local/share/iterate/spec-marker.txt";

    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    // Machine A: create, write a marker file to the persisted directory.
    await createMachineFromUi(page, machineA, imageTag);
    const writeOutput = await runCommandOnMachine(
      page,
      `mkdir -p ~/.local/share/iterate && printf '%s' '${marker}' > ${markerPath} && cat ${markerPath}`,
    );
    expect(writeOutput).toContain(marker);

    // Machine B: replace machine, read the marker file back.
    await createMachineFromUi(page, machineB, imageTag);
    const readOutput = await runCommandOnMachine(page, `cat ${markerPath}`);
    expect(readOutput).toContain(marker);
  });

  test("webchat conversation persists across machine replacement", async ({ page }) => {
    test.setTimeout(900_000);
    test.skip(
      process.env.MACHINE_PERSISTENCE_SPEC !== "1",
      "Set MACHINE_PERSISTENCE_SPEC=1 to run machine persistence specs",
    );

    const imageTag = resolveImageTag();
    const now = Date.now();
    const testEmail = `persist-webchat-${now}+test@nustom.com`;
    const machineA = `Chat A ${now}`;
    const machineB = `Chat B ${now}`;

    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    // Machine A: create, activate, then send a message via the webchat UI.
    await createMachineFromUi(page, machineA, imageTag);
    await sidebarButton(page, "Home").click();
    await webchatSend(page, "the secret word is banana");

    // Machine B: replace machine, then ask for the secret word in the same thread.
    await createMachineFromUi(page, machineB, imageTag);
    await sidebarButton(page, "Home").click();
    const reply = await webchatSend(page, "what's the secret word? reply with just the word");
    await reply.getByText("banana").waitFor();
  });
});

// ── Pull iterate/iterate ───────────────────────────────────────────

/** Repo root for git operations. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Create a temporary git branch with a unique greeting baked into the daemon's
 * execCommand response. Uses a git worktree so the working directory running
 * the test is unaffected. The branch is pushed to origin and cleaned up when
 * disposed.
 */
function createTestBranch(branchName: string, greeting: string) {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pull-iterate-spec-"));

  // Create worktree + branch off HEAD
  execSync(`git worktree add -b ${branchName} ${worktreeDir} HEAD`, {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });

  // Patch execCommand to include the greeting
  const toolsFile = path.join(worktreeDir, "apps/daemon/server/orpc/procedures/tools.ts");
  const original = fs.readFileSync(toolsFile, "utf-8");
  const patchBefore = "exitCode: result.exitCode";
  const patchIndex = original.indexOf(patchBefore);
  if (patchIndex === -1)
    throw new Error(`Can't patch ${toolsFile}: couldn't  find "${patchBefore}`);
  if (patchIndex !== original.lastIndexOf(patchBefore))
    throw new Error(`Can't patch ${toolsFile}: "${patchBefore}" appears multiple times`);

  const beforePatch = original.slice(0, patchIndex);
  const patched =
    beforePatch +
    `greeting: ${JSON.stringify(greeting)},\n` +
    original.slice(beforePatch.trimEnd().length, beforePatch.length) + // whitespace
    original.slice(patchIndex + patchBefore.length);

  fs.writeFileSync(toolsFile, patched);

  // Commit and push
  execSync(`git add -A && git commit --no-verify -m "test: add greeting ${greeting}"`, {
    cwd: worktreeDir,
    stdio: "pipe",
  });
  execSync(`git push origin ${branchName}`, { cwd: worktreeDir, stdio: "pipe" });

  return {
    branchName,
    greeting,
    [Symbol.asyncDispose]: async () => {
      try {
        execSync(`git worktree remove --force ${worktreeDir}`, { cwd: REPO_ROOT, stdio: "pipe" });
      } catch {
        /* already removed */
      }
      try {
        execSync(`git branch -D ${branchName}`, { cwd: REPO_ROOT, stdio: "pipe" });
      } catch {
        /* already deleted */
      }
      try {
        execSync(`git push origin --delete ${branchName}`, { cwd: REPO_ROOT, stdio: "pipe" });
      } catch {
        /* already deleted or push failed */
      }
    },
  };
}

/**
 * Click "Pull iterate/iterate" on the machine detail page.
 * Overrides window.prompt to supply the ref automatically.
 */
async function pullIterateIterate(page: Page, ref: string) {
  await page.evaluate((r) => (window.prompt = () => r), ref);
  await page.getByRole("button", { name: "Pull iterate/iterate" }).click();
  await page.getByText("Pull triggered").waitFor();
}

test.describe("pull iterate/iterate", () => {
  test("in-place code update via pull button", async ({ page }) => {
    test.setTimeout(900_000);
    test.skip(
      process.env.MACHINE_PERSISTENCE_SPEC !== "1",
      "Set MACHINE_PERSISTENCE_SPEC=1 to run machine persistence specs",
    );

    const imageTag = resolveImageTag();
    const now = Date.now();
    const testEmail = `pull-iterate-${now}+test@nustom.com`;
    const machineName = `Pull Test ${now}`;
    const greeting = `greeting-${now}`;
    const branchName = `test/pull-iterate-${now}`;

    await using _branch = createTestBranch(branchName, greeting);

    await login(page, testEmail);
    await createOrganization(page);
    await createProject(page);

    // Create a machine and wait for it to become active.
    await createMachineFromUi(page, machineName, imageTag);

    // Trigger the pull.
    await pullIterateIterate(page, branchName);

    // Poll "Run command" until the greeting appears in the output.
    // The daemon restarts during the pull, so expect transient errors — just keep retrying.
    await expect
      .poll(async () => runCommandOnMachine(page, "git status").catch(String), {
        timeout: 120_000,
        intervals: [3_000],
      })
      .toContain(greeting);
  });
});

// ── Helpers ────────────────────────────────────────────────────────

async function webchatSend(page: Page, text: string) {
  await page.getByTestId("webchat-input").fill(text);
  await page.getByTestId("webchat-send").click();
  const userMessage = page.getByTestId("webchat-message-user").filter({ hasText: text });
  await userMessage.waitFor();
  const userMessageId = await userMessage.getAttribute("data-message-id");

  const reply = page
    .locator(`[data-message-id="${userMessageId}"] ~ [data-testid="webchat-message-assistant"]`)
    .first();
  await reply.waitFor();
  return reply;
}
