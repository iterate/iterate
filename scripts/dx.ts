/**
 * DX Check — Developer Experience verification script.
 *
 * Verifies that the dev loop works end-to-end:
 * 1. Dev server starts and renders the app
 * 2. OS frontend HMR propagates code changes to the browser
 * 3. Daemon code sync propagates changes to a running sandbox
 *
 * Built as a trpc-cli so each phase can be run independently:
 *   tsx scripts/dx.ts setup
 *   tsx scripts/dx.ts bootstrap
 *   tsx scripts/dx.ts os-hmr
 *   tsx scripts/dx.ts daemon-sync
 *   tsx scripts/dx.ts cleanup
 *   tsx scripts/dx.ts all          # runs everything in sequence
 *
 * Or use the convenience script:
 *   ./scripts/run-dx.sh
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync, spawn, type ExecSyncOptions, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { createCli } from "trpc-cli";
import { initTRPC } from "@trpc/server";
import type { TrpcCliMeta } from "trpc-cli";

const t = initTRPC.meta<TrpcCliMeta>().create();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ROOT = path.resolve(import.meta.dirname, "..");
const STATE_FILE = path.join(ROOT, "test-results", "dx-state.json");
const GENERATED_DIR = path.join(ROOT, "spec", "_generated");
const BASE_URL = process.env.APP_URL || "http://localhost:5173";

// Files we modify during HMR/sync checks — restored on cleanup
const OS_HMR_TARGET = path.join(ROOT, "apps/os/app/components/auth-components.tsx");
const DAEMON_PROMPT_TARGET = path.join(ROOT, "sandbox/home-skeleton/.config/opencode/AGENTS.md");

// ---------------------------------------------------------------------------
// DX State schema — written by bootstrap, read by later phases
// ---------------------------------------------------------------------------
const DxState = z.object({
  email: z.string(),
  orgName: z.string(),
  projectName: z.string(),
  timestamp: z.number(),
  baseUrl: z.string(),
  dockerImage: z.string().optional(),
});
type DxState = z.infer<typeof DxState>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function codeWord(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

function run(cmd: string, opts?: ExecSyncOptions & { allowFailure?: boolean }): string {
  const { allowFailure, ...execOpts } = opts ?? {};
  console.log(`  $ ${cmd}`);
  try {
    const result = execSync(cmd, { encoding: "utf-8", cwd: ROOT, stdio: "pipe", ...execOpts });
    return String(result).trim();
  } catch (err: any) {
    if (allowFailure) {
      return err.stdout?.toString().trim() ?? "";
    }
    console.error(err.stderr?.toString() ?? err.message);
    throw err;
  }
}

function writeGeneratedSpec(filename: string, content: string): string {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const filepath = path.join(GENERATED_DIR, filename);
  fs.writeFileSync(filepath, content);
  console.log(`  Generated ${path.relative(ROOT, filepath)}`);
  return filepath;
}

function runPlaywright(specPath: string, opts?: { expectFailure?: boolean }): void {
  const relPath = path.relative(ROOT, specPath);
  const cmd = `pnpm exec playwright test ${relPath} --reporter=list`;
  console.log(`  Running: ${cmd}`);
  try {
    execSync(cmd, {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        APP_URL: BASE_URL,
        // Ensure we don't prompt for install
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
    });
    if (opts?.expectFailure) {
      throw new Error(`Expected playwright to FAIL for ${relPath}, but it passed.`);
    }
    console.log(`  ✓ Spec passed: ${relPath}`);
  } catch (err: any) {
    if (opts?.expectFailure) {
      console.log(`  ✓ Spec failed as expected: ${relPath}`);
      return;
    }
    throw Object.assign(new Error(`Spec failed unexpectedly: ${relPath}`), { cause: err });
  }
}

function readState(): DxState {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`DX state file not found at ${STATE_FILE}. Run 'dx bootstrap' first.`);
  }
  return DxState.parse(JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Dev server management — start once, keep running across playwright invocations
// ---------------------------------------------------------------------------
let devServerProcess: ChildProcess | null = null;

async function ensureDevServer(): Promise<void> {
  // Check if already reachable
  try {
    const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok || res.status < 500) return;
  } catch {
    // not reachable, need to start
  }

  if (devServerProcess) return; // already starting

  console.log(`  Starting dev server (pnpm dev)...`);
  devServerProcess = spawn("pnpm", ["dev"], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
    env: { ...process.env },
  });
  devServerProcess.unref();

  // Wait for it to become reachable
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(3000) });
      if (res.ok || res.status < 500) {
        console.log(`  ✓ Dev server started`);
        return;
      }
    } catch {
      // not yet
    }
    await sleep(2000);
  }
  throw new Error(`Dev server failed to start within 180s`);
}

function stopDevServer(): void {
  if (devServerProcess?.pid) {
    try {
      // Kill the process group (detached)
      process.kill(-devServerProcess.pid, "SIGTERM");
    } catch {
      // already dead
    }
    devServerProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

const setup = t.procedure
  .meta({ description: "Verify prerequisites: git clean, docker up, dev server reachable" })
  .mutation(async () => {
    console.log("\n=== DX Setup ===\n");

    // Check git is clean (only tracked files that we might modify)
    // In CI, pnpm install may update the lockfile, so we only check the specific
    // files we'll be modifying during the dx checks.
    const filesToCheck = [OS_HMR_TARGET, DAEMON_PROMPT_TARGET];
    for (const file of filesToCheck) {
      const relFile = path.relative(ROOT, file);
      try {
        run(`git diff --quiet -- ${relFile}`);
      } catch {
        throw new Error(
          `File ${relFile} has uncommitted changes.\n` +
            "The dx script modifies source files temporarily and needs them clean to restore.",
        );
      }
    }
    console.log("  ✓ Target files are clean");

    // Check docker is up (postgres container from compose)
    const pgContainer = run(
      `docker ps --filter "label=com.docker.compose.service=postgres" --format "{{.Names}}"`,
      { allowFailure: true },
    );
    if (!pgContainer) {
      throw new Error("Docker compose not running. Run 'pnpm docker:up' first.");
    }
    console.log("  ✓ Docker compose is running");

    // Ensure dev server is running. If it's not reachable, start it as a background
    // process. This avoids each playwright invocation starting/stopping its own server.
    await ensureDevServer();

    // Ensure generated dir exists
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    console.log("  ✓ Setup complete");
  });

const bootstrap = t.procedure
  .meta({
    description: "Create org/project/machine via Playwright, save state for later phases",
  })
  .mutation(async () => {
    console.log("\n=== DX Bootstrap ===\n");

    const timestamp = Date.now();

    // Detect a local Docker sandbox image to use.
    // DOCKER_DEFAULT_IMAGE may point to a registry image not available locally.
    // Fall back to finding a locally-built iterate-sandbox image.
    let dockerImage = process.env.DOCKER_DEFAULT_IMAGE ?? "";
    const localImageCheck = run(
      `docker images iterate-sandbox --format "{{.Repository}}:{{.Tag}}" | head -1`,
      { allowFailure: true },
    );
    if (localImageCheck) {
      // Verify DOCKER_DEFAULT_IMAGE exists locally; if not, use the local image
      const defaultExists = dockerImage
        ? run(`docker image inspect ${dockerImage} > /dev/null 2>&1 && echo yes || echo no`, {
            allowFailure: true,
          })
        : "no";
      if (defaultExists !== "yes") {
        console.log(
          `  DOCKER_DEFAULT_IMAGE (${dockerImage}) not found locally, using ${localImageCheck}`,
        );
        dockerImage = localImageCheck;
      }
    }

    const state: DxState = {
      email: `dx-check-${timestamp}+test@nustom.com`,
      orgName: `DX Org ${timestamp}`,
      projectName: `DX Project ${timestamp}`,
      timestamp,
      baseUrl: BASE_URL,
      dockerImage: dockerImage || undefined,
    };

    // Phase 1: Create org/project/machine via Playwright
    const createSpecContent = `
import { expect } from "@playwright/test";
import { login, test, createOrganization, sidebarButton } from "../test-helpers.ts";

test("dx bootstrap: create org, project, and machine", async ({ page }) => {
  test.setTimeout(120_000);

  await login(page, ${JSON.stringify(state.email)});
  await createOrganization(page, ${JSON.stringify(state.orgName)});

  // Create project with Docker provider.
  await sidebarButton(page, /^(Create|New) project$/).click();
  await page.getByLabel("Project name").fill(${JSON.stringify(state.projectName)});

  // Select Docker provider via the shadcn Select component.
  const providerTrigger = page.getByRole("combobox");
  if (await providerTrigger.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await providerTrigger.click();
    await page.getByRole("option", { name: "Docker" }).click();
  }

  await page.getByRole("button", { name: "Create project" }).click();
  await page.locator("[data-slot='sidebar']").waitFor({ timeout: 15_000 });

  // Navigate to Machines and create one
  await sidebarButton(page, "Machines").click();
  await page.getByRole("link", { name: "Create Machine" }).or(
    page.getByRole("button", { name: "Create Machine" })
  ).click();

  const nameInput = page.getByPlaceholder("Machine name");
  await nameInput.clear();
  await nameInput.fill("DX Machine ${timestamp}");

  ${
    state.dockerImage
      ? `// Fill in the Docker image override (DOCKER_DEFAULT_IMAGE may not exist locally)
  const imageInput = page.getByPlaceholder(/iterate-sandbox/);
  if (await imageInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await imageInput.fill(${JSON.stringify(state.dockerImage)});
  }`
      : "// No docker image override needed"
  }

  await page.getByRole("button", { name: "Create" }).click();

  // Verify machine appears in the list (state=starting is fine, activation takes time)
  const machineCard = page.getByRole("link", { name: /DX Machine/ });
  await machineCard.waitFor({ timeout: 30_000 });
  const text = await machineCard.first().innerText();
  expect(text).toContain("DX Machine");
});
`;
    const createSpecPath = writeGeneratedSpec("dx-bootstrap-create.spec.ts", createSpecContent);
    runPlaywright(createSpecPath);

    // Phase 2: Wait for machine activation (Node.js polling loop).
    // In dev mode there's no cron to process the outbox queue. Delayed consumers
    // (readiness probe has 60s delay) need manual queue processing triggers.
    // We trigger processing by hitting the app, which runs processQueue in waitUntil.
    console.log("  Waiting for machine activation (polling + triggering queue processing)...");
    const activationDeadline = Date.now() + 300_000; // 5 min
    let machineState = "unknown";
    while (Date.now() < activationDeadline) {
      // Hit any app endpoint to trigger waitUntil-based queue processing
      await fetch(`${BASE_URL}/api/trpc/admin.outbox.process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).catch(() => {});

      // Also try a simple GET to trigger any pending waitUntil callbacks
      await fetch(`${BASE_URL}/`).catch(() => {});

      // Check machine state directly via DB
      const dbResult = run(
        `docker exec iterate-iterate-e25f-postgres-1 psql -U postgres -d os -tAc ` +
          `"SELECT state FROM machine WHERE name LIKE 'DX Machine ${timestamp}%' LIMIT 1;"`,
        { allowFailure: true },
      ).trim();

      if (dbResult === "active") {
        machineState = "active";
        break;
      }
      machineState = dbResult || "not-found";
      console.log(
        `    Machine state: ${machineState} (${Math.round((activationDeadline - Date.now()) / 1000)}s remaining)`,
      );
      await sleep(10_000);
    }

    if (machineState !== "active") {
      // Check queue for diagnostics
      const queueInfo = run(
        `docker exec iterate-iterate-e25f-postgres-1 psql -U postgres -d os -tAc ` +
          `"SELECT message->>'consumer_name' || ': ' || message->>'status' || ' ' || COALESCE(message->'processing_results'->>-1, '') FROM pgmq.q_consumer_job_queue ORDER BY msg_id DESC LIMIT 5;"`,
        { allowFailure: true },
      );
      throw new Error(
        `Machine did not reach active state within 5 min. Last state: ${machineState}\nQueue info:\n${queueInfo}`,
      );
    }
    console.log("  ✓ Machine is active");

    // Phase 3: Verify webchat is accessible
    const verifySpecContent = `
import { expect } from "@playwright/test";
import { login, test, sidebarButton } from "../test-helpers.ts";

test("dx bootstrap: verify webchat accessible", async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, ${JSON.stringify(state.email)});
  await page.locator("[data-slot='sidebar']").waitFor({ timeout: 15_000 }).catch(() => {});
  await sidebarButton(page, "Home").click();
  await page.getByTestId("webchat-input").and(page.locator(":not([disabled])")).waitFor({ timeout: 30_000 });
});
`;
    const verifySpecPath = writeGeneratedSpec("dx-bootstrap-verify.spec.ts", verifySpecContent);
    runPlaywright(verifySpecPath);

    // Save state
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`  State saved to ${path.relative(ROOT, STATE_FILE)}`);
    console.log(`  ✓ Bootstrap complete`);
  });

const osHmr = t.procedure
  .meta({
    description:
      "Verify OS frontend HMR: modify login page text, assert it appears, revert, assert it vanishes",
  })
  .mutation(async () => {
    console.log("\n=== DX OS HMR Check ===\n");

    const word = codeWord("dx_os");
    console.log(`  Code word: ${word}`);

    // Read original file
    const original = fs.readFileSync(OS_HMR_TARGET, "utf-8");

    // The login page shows "Continue with Email" — modify it.
    // This page is visible without auth, so the HMR check is independent of login state.
    const searchStr = `"Continue with Email"`;
    if (!original.includes(searchStr)) {
      throw new Error(`Could not find ${searchStr} in ${path.relative(ROOT, OS_HMR_TARGET)}`);
    }
    const modified = original.replace(searchStr, `"Continue with Email ${word}"`);

    // Generate spec that checks the login page for the code word
    const specContent = `
import { expect } from "@playwright/test";
import { test } from "../test-helpers.ts";

test("dx os-hmr: login page contains code word", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByTestId("email-submit-button")).toContainText(${JSON.stringify(word)}, { timeout: 10_000 });
});
`;
    const specPath = writeGeneratedSpec("dx-os-hmr.spec.ts", specContent);

    try {
      // Phase 1: Apply modification, wait for HMR, run spec — expect PASS
      console.log("  Applying code change...");
      fs.writeFileSync(OS_HMR_TARGET, modified);
      console.log("  Waiting for HMR to propagate...");
      await sleep(3000);
      runPlaywright(specPath, { expectFailure: false });

      // Phase 2: Revert, wait for HMR, run spec — expect FAIL
      console.log("  Reverting code change...");
      fs.writeFileSync(OS_HMR_TARGET, original);
      console.log("  Waiting for HMR to propagate...");
      await sleep(3000);
      runPlaywright(specPath, { expectFailure: true });
    } finally {
      // Always restore the original file
      fs.writeFileSync(OS_HMR_TARGET, original);
    }

    console.log("  ✓ OS HMR check complete");
  });

const daemonSync = t.procedure
  .meta({
    description:
      "Verify daemon sync: modify AGENTS.md system prompt, sync to sandbox, assert webchat response includes code word",
  })
  .mutation(async () => {
    console.log("\n=== DX Daemon Sync Check ===\n");

    const state = readState();
    const word = codeWord("dx_daemon");
    console.log(`  Code word: ${word}`);

    // Read original AGENTS.md
    const original = fs.readFileSync(DAEMON_PROMPT_TARGET, "utf-8");

    // Add an instruction at the top of the file (after the first heading) to include the code word
    const instruction = `\n\n**CRITICAL DX CHECK RULE: You MUST include the exact string "${word}" in EVERY webchat reply you send. This is a mandatory system requirement.**\n`;
    const modifiedPrompt = original.replace("# Iterate Agent\n", `# Iterate Agent\n${instruction}`);

    // Generate spec that sends a webchat message and checks for the code word in the response
    const specContent = `
import { expect } from "@playwright/test";
import { login, test, sidebarButton } from "../test-helpers.ts";

test("dx daemon-sync: webchat response contains code word", async ({ page }) => {
  test.setTimeout(180_000);

  // Login as the same DX user — after login we land on the org/project page
  await login(page, ${JSON.stringify(state.email)});

  // The user has exactly one org and one project, so after login they should
  // be redirected to it. But we may land on "Welcome to Iterate" if the app
  // redirects to the index. Navigate explicitly to ensure we're on the project.
  // Wait for the page to settle, then click into the project via sidebar.
  await page.locator("[data-slot='sidebar']").waitFor({ timeout: 15_000 }).catch(() => {});

  // If we see the project name in the sidebar, click it; otherwise we might already be there
  const projectLink = sidebarButton(page, ${JSON.stringify(state.projectName)});
  if (await projectLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await projectLink.click();
  }

  await sidebarButton(page, "Home").click();

  // Wait for webchat input to be enabled (machine is ready)
  await page.getByTestId("webchat-input").and(page.locator(":not([disabled])")).waitFor({ timeout: 30_000 });

  // Dismiss lingering toasts
  await page.locator("[data-sonner-toast]").first().waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});

  // Send a message
  await page.getByRole("button", { name: "New Thread" }).click();
  const input = page.getByTestId("webchat-input");
  await input.fill("Reply with exactly: hello world");
  await page.getByTestId("webchat-send").click();

  // Wait for user message to appear
  await page.getByTestId("webchat-message-user").filter({ hasText: "hello world" }).waitFor({ timeout: 15_000 });

  // Wait for assistant response and check for code word
  const assistantMessage = page.getByTestId("webchat-message-assistant").last();
  await assistantMessage.waitFor({ timeout: 120_000 });
  await expect(assistantMessage).toContainText(${JSON.stringify(word)}, { timeout: 30_000 });
});
`;
    const specPath = writeGeneratedSpec("dx-daemon-sync.spec.ts", specContent);

    try {
      // Phase 1: Apply modification, sync to sandbox, run spec — expect PASS
      console.log("  Applying AGENTS.md change...");
      fs.writeFileSync(DAEMON_PROMPT_TARGET, modifiedPrompt);

      console.log("  Syncing to sandbox (--fast)...");
      run("bash scripts/sandbox-sync.sh --fast");

      console.log("  Waiting for daemon restart...");
      await sleep(5000);

      runPlaywright(specPath, { expectFailure: false });

      // Phase 2: Revert, re-sync, run spec — expect FAIL
      console.log("  Reverting AGENTS.md...");
      fs.writeFileSync(DAEMON_PROMPT_TARGET, original);

      console.log("  Re-syncing to sandbox (--fast)...");
      run("bash scripts/sandbox-sync.sh --fast");

      console.log("  Waiting for daemon restart...");
      await sleep(5000);

      runPlaywright(specPath, { expectFailure: true });
    } finally {
      // Always restore the original
      fs.writeFileSync(DAEMON_PROMPT_TARGET, original);
    }

    console.log("  ✓ Daemon sync check complete");
  });

const cleanup = t.procedure
  .meta({
    description: "Restore git state, remove generated files, stop dev server if we started it",
  })
  .mutation(() => {
    console.log("\n=== DX Cleanup ===\n");

    // Restore any modified files
    run("git checkout -- .", { allowFailure: true });
    console.log("  ✓ Git state restored");

    // Remove generated specs
    if (fs.existsSync(GENERATED_DIR)) {
      const files = fs.readdirSync(GENERATED_DIR).filter((f) => f.endsWith(".spec.ts"));
      for (const f of files) {
        fs.unlinkSync(path.join(GENERATED_DIR, f));
        console.log(`  Removed ${f}`);
      }
    }

    // Remove state file
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
      console.log("  Removed dx-state.json");
    }

    // Stop dev server if we started it
    stopDevServer();

    console.log("  ✓ Cleanup complete");
  });

const all = t.procedure
  .meta({
    description:
      "Run all DX checks end-to-end (setup → bootstrap → os-hmr → daemon-sync → cleanup)",
  })
  .mutation(async () => {
    console.log("╔══════════════════════════════════════╗");
    console.log("║       DX Check — Full Pipeline       ║");
    console.log("╚══════════════════════════════════════╝");

    const caller = router.createCaller({});

    try {
      await caller.setup();
      await caller.bootstrap();
      await caller.osHmr();
      await caller.daemonSync();
    } finally {
      await caller.cleanup();
    }

    console.log("\n🎉 All DX checks passed!\n");
  });

// ---------------------------------------------------------------------------
// Router & CLI
// ---------------------------------------------------------------------------
const router = t.router({
  setup,
  bootstrap,
  osHmr: osHmr,
  daemonSync: daemonSync,
  cleanup,
  all,
});

const cli = createCli({ router, name: "dx", description: "Developer experience checks" });

cli.run();
