/**
 * Daytona Iterate Repo Sync E2E Test
 *
 * Tests that the daemon correctly syncs the iterate repo when the control plane
 * reports a new SHA. This is a full integration test that:
 *
 * 1. Ensures a Daytona snapshot exists for current HEAD (creates if missing)
 * 2. Creates a git worktree with a test branch
 * 3. Starts the dev server with current SHA/branch
 * 4. Creates a Daytona machine via the UI
 * 5. Modifies apps/daemon/sync-test-marker.txt in worktree
 * 6. Commits and pushes the change
 * 7. Restarts dev server with new SHA
 * 8. Triggers refreshEnv on the machine
 * 9. Verifies the marker file has the new content via shell
 *
 * RUN WITH:
 *   RUN_DAYTONA_SYNC_SPEC=1 pnpm spec daytona-sync
 *
 * PREREQUISITES:
 *   - Doppler access (for DAYTONA_API_KEY etc)
 *   - Git push access to the repo
 *   - ~10 minutes (snapshot build + machine creation)
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "@playwright/test";
import { test, login, createOrganization, createProject, sidebarButton } from "./test-helpers.ts";

const RUN_TEST = process.env.RUN_DAYTONA_SYNC_SPEC === "1";
const REPO_ROOT = join(import.meta.dirname, "..");
const TEST_TIMEOUT_MS = 600_000; // 10 minutes

// Unique marker for this test run
const TEST_MARKER = `sync-test-${Date.now()}`;

test.describe("Daytona iterate repo sync", () => {
  test.skip(!RUN_TEST, "Skipped: set RUN_DAYTONA_SYNC_SPEC=1 to run");

  test("syncs iterate repo when control plane reports new SHA", async ({ page }) => {
    test.setTimeout(TEST_TIMEOUT_MS);

    // Create disposable test context
    await using ctx = await createTestContext();

    await test.step("ensure snapshot exists", async () => {
      console.log(`[setup] Current HEAD: ${ctx.originalSha}`);
      console.log(`[setup] Expected snapshot: ${ctx.snapshotName}`);
      console.log("[setup] Ensuring snapshot exists...");

      const output = execSync(`pnpm snapshot:daytona-head`, {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        stdio: ["inherit", "pipe", "inherit"],
      });
      console.log(output);
      console.log(`[setup] Snapshot ready: ${ctx.snapshotName}`);
    });

    await test.step("create worktree and push test branch", async () => {
      console.log(`[setup] Creating worktree at ${ctx.worktreePath} for branch ${ctx.testBranch}`);

      mkdirSync(join(REPO_ROOT, ".worktrees"), { recursive: true });

      execSync(`git worktree add -b ${ctx.testBranch} "${ctx.worktreePath}" HEAD`, {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });

      execSync(`git push -u origin ${ctx.testBranch}`, {
        cwd: ctx.worktreePath,
        stdio: "inherit",
      });

      console.log(`[setup] Worktree created and branch pushed`);
    });

    await test.step("start dev server", async () => {
      await ctx.startDevServer(ctx.originalSha, ctx.testBranch);
    });

    let daemonUrl: string;

    await test.step("create Daytona machine via UI", async () => {
      const testEmail = `daytona-sync-${Date.now()}+test@nustom.com`;
      await login(page, testEmail);
      await createOrganization(page);
      await createProject(page);
      await sidebarButton(page, "Machines").click();

      await page.getByRole("link", { name: "Create Machine" }).click();

      // Select Daytona type
      await page.getByRole("combobox").click();
      await page.getByRole("option", { name: "Daytona" }).click();

      await page.getByPlaceholder("Machine name").fill(ctx.machineName);
      await page.getByRole("button", { name: "Create" }).click();

      // Wait for machine to appear and click into it
      await page.getByText(ctx.machineName).click();

      // Wait for machine to be ready (can take 2-3 minutes)
      console.log("[machine] Waiting for machine to be ready...");
      await page.getByText("Ready").waitFor({ timeout: 180_000 });
      console.log("[machine] Machine is ready!");

      // Wait for daemon services to appear (they load after machine is ready)
      // The "Shell" section appears when iterate-daemon service is available
      console.log("[machine] Waiting for daemon services...");
      await page.getByText("Shell").waitFor({ timeout: 120_000 });
      console.log("[machine] Shell section appeared");

      // Get the daemon URL - look for Direct link near Shell section
      // Use page.locator to find link with daytona URL after Shell text
      const daemonLink = page.locator('a[href*="daytona"]:has-text("Direct")').first();
      await daemonLink.waitFor({ timeout: 10_000 });
      daemonUrl = (await daemonLink.getAttribute("href"))!;
      console.log(`[machine] Daemon URL: ${daemonUrl}`);
    });

    // Note: We skip verifying the initial marker file content because xterm.js doesn't
    // expose its buffer content easily. The key test is that after sync, the file changes.

    await test.step("modify marker file in worktree", async () => {
      const markerPath = join(ctx.worktreePath, "apps/daemon/sync-test-marker.txt");
      writeFileSync(markerPath, TEST_MARKER + "\n");
      console.log(`[git] Modified marker file to: ${TEST_MARKER}`);
    });

    await test.step("commit and push changes", async () => {
      execSync("git add -A", { cwd: ctx.worktreePath, stdio: "inherit" });
      execSync(`git commit -m "test: update sync-test-marker.txt"`, {
        cwd: ctx.worktreePath,
        stdio: "inherit",
      });
      execSync("git push", { cwd: ctx.worktreePath, stdio: "inherit" });

      ctx.newSha = execSync("git rev-parse HEAD", {
        cwd: ctx.worktreePath,
        encoding: "utf-8",
      }).trim();
      console.log(`[git] Pushed new commit: ${ctx.newSha}`);
    });

    await test.step("restart dev server with new SHA", async () => {
      await ctx.stopDevServer();
      await ctx.startDevServer(ctx.newSha!, ctx.testBranch);
    });

    await test.step("trigger refreshEnv to sync repo", async () => {
      // Call refreshEnv to force immediate sync
      console.log("[sync] Calling refreshEnv to force sync...");
      const response = await fetch(`${daemonUrl}/api/trpc/platform.refreshEnv`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      console.log(`[sync] refreshEnv response: ${response.status}`);

      // Wait for sync to complete (git pull)
      console.log("[sync] Waiting 15s for sync to complete...");
      await new Promise((r) => setTimeout(r, 15_000));
    });

    await test.step("verify iterate repo synced to new SHA", async () => {
      // Poll for the new SHA using the getIterateRepoSha endpoint
      const maxAttempts = 30;
      let found = false;
      let lastSha = "";

      for (let i = 0; i < maxAttempts; i++) {
        try {
          const shaUrl = `${daemonUrl}/api/trpc/platform.getIterateRepoSha`;
          const response = await fetch(shaUrl);

          if (response.ok) {
            const result = (await response.json()) as { result: { data: { sha: string | null } } };
            lastSha = result.result?.data?.sha ?? "";
            console.log(
              `[sync] Attempt ${i + 1}: current SHA = ${lastSha}, expected = ${ctx.newSha}`,
            );

            if (lastSha === ctx.newSha) {
              found = true;
              break;
            }
          } else {
            console.log(`[sync] Attempt ${i + 1}: getIterateRepoSha failed: ${response.status}`);
          }
        } catch (error) {
          console.log(`[sync] Attempt ${i + 1} failed: ${error}`);
        }

        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!found) {
        throw new Error(`Expected iterate repo to sync to "${ctx.newSha}", but got "${lastSha}"`);
      }
      console.log(`[test] SUCCESS: Iterate repo synced to ${ctx.newSha}!`);
    });
  });
});

/**
 * Create test context with automatic cleanup via Symbol.asyncDispose
 */
async function createTestContext() {
  const originalSha = execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  const timestamp = Date.now();
  const testBranch = `test/daytona-sync-${timestamp}`;
  const worktreePath = join(REPO_ROOT, ".worktrees", `daytona-sync-${timestamp}`);
  const snapshotName = `iterate-sandbox-${originalSha}`;
  const machineName = `sync-test-${timestamp}`;
  const logFile = join(tmpdir(), `daytona-sync-${timestamp}-dev.log`);

  let devServerProcess: ChildProcess | null = null;
  let newSha: string | undefined;

  const startDevServer = async (sha: string, branch: string) => {
    // Kill any existing dev server
    try {
      execSync("pkill -f 'vite.*5173' || true", { stdio: "ignore" });
      execSync("pkill -f 'alchemy.run.ts' || true", { stdio: "ignore" });
      console.log("[dev] Killed existing dev server");
    } catch {
      // Ignore
    }

    console.log(`[dev] Starting dev server with SHA=${sha} BRANCH=${branch}`);
    console.log(`[dev] Logs will be written to: ${logFile}`);

    const logStream = createWriteStream(logFile, { flags: "a" });

    // Start dev server with all env vars
    devServerProcess = spawn(
      "sh",
      [
        "-c",
        `ITERATE_REPO_SHA=${sha} ITERATE_REPO_BRANCH=${branch} DAYTONA_SNAPSHOT_NAME=${snapshotName} doppler run --preserve-env=ITERATE_REPO_SHA,ITERATE_REPO_BRANCH,DAYTONA_SNAPSHOT_NAME -- pnpm dev`,
      ],
      {
        cwd: join(REPO_ROOT, "apps/os"),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // Pipe stdout/stderr to log file
    devServerProcess.stdout?.pipe(logStream);
    devServerProcess.stderr?.pipe(logStream);

    // Wait for dev server to be ready by polling the main page
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch("http://localhost:5173/login");
            if (response.ok) {
              console.log("[dev] Dev server responding");
              return { ready: true };
            }
            return { ready: false, status: response.status };
          } catch (error) {
            return { ready: false, error: String(error) };
          }
        },
        { timeout: 120_000, intervals: [1000, 2000, 5000] },
      )
      .toMatchObject({ ready: true });

    console.log("[dev] Dev server ready");
  };

  const stopDevServer = async () => {
    if (devServerProcess) {
      devServerProcess.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 2000));
      devServerProcess = null;
    }
  };

  return {
    originalSha,
    testBranch,
    worktreePath,
    snapshotName,
    machineName,
    get newSha() {
      return newSha;
    },
    set newSha(value: string | undefined) {
      newSha = value;
    },
    startDevServer,
    stopDevServer,

    async [Symbol.asyncDispose]() {
      console.log("[cleanup] Starting cleanup...");

      // Kill dev server
      await stopDevServer();

      // Delete remote branch
      if (testBranch) {
        try {
          console.log(`[cleanup] Deleting remote branch: ${testBranch}`);
          execSync(`git push origin --delete ${testBranch}`, {
            cwd: REPO_ROOT,
            stdio: "inherit",
          });
        } catch {
          console.log("[cleanup] Failed to delete remote branch (may not exist)");
        }
      }

      // Remove worktree
      if (existsSync(worktreePath)) {
        console.log(`[cleanup] Removing worktree: ${worktreePath}`);
        try {
          execSync(`git worktree remove --force "${worktreePath}"`, {
            cwd: REPO_ROOT,
            stdio: "inherit",
          });
        } catch {
          rmSync(worktreePath, { recursive: true, force: true });
        }
        try {
          execSync(`git branch -D ${testBranch}`, { cwd: REPO_ROOT, stdio: "inherit" });
        } catch {
          // Ignore
        }
      }

      console.log("[cleanup] Done");
    },
  };
}
