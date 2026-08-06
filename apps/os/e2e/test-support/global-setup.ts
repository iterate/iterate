/**
 * Vitest globalSetup: give `pnpm e2e` the same dev-server ergonomics as the
 * root Playwright lane (`pnpm spec`), whose webServer block this mirrors:
 *
 * - `APP_CONFIG_BASE_URL` set (a deployed target — always the case in CI):
 *   strict no-op, exactly like Playwright skipping its webServer block.
 * - A LIVE local dev server is discoverable (`.dev-server/dev-server.json`
 *   with its pid still running): reuse it, like Playwright's
 *   `reuseExistingServer: !CI`.
 * - Otherwise: start one detached via scripts/dev.ts — the same
 *   `start --detach` lane Playwright's webServer command drives — and wait
 *   for `/api/health`. The server deliberately outlives the run (Playwright's
 *   `--keep-alive` wrapper leaves the detached vite behind too): the next
 *   `pnpm e2e` / `pnpm spec` reuses it, and `pnpm dev kill` stops it.
 * - `CI` set without a base URL: never boot a server on a CI runner. The
 *   suites keep failing with their existing clear "APP_CONFIG_BASE_URL is
 *   required" error.
 *
 * Runs once per vitest run: vitest reads `globalSetup` per project (like
 * `retry`), and the globalThis-promise dedupe keeps this a single run even
 * if more projects list it (today only the `node` project does).
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import startDevServer, { localOsDevServer } from "../../scripts/dev.ts";
import { devServerLogPath } from "../../scripts/lib/dev-server-info.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

// Symbol.for-keyed globalThis stashes: config eval (vite's bundled config)
// and setup files (vite-node) can get separate module instances in one
// process, so the stash — not module state — is the dedupe.
const TARGET_KEY: unique symbol = Symbol.for("iterate.osE2e.localDevTarget");
const ENSURE_KEY: unique symbol = Symbol.for("iterate.osE2e.ensureDevServer");
const stash = globalThis as typeof globalThis & {
  [TARGET_KEY]?: ReturnType<typeof localOsDevServer.resolveTarget>;
  [ENSURE_KEY]?: Promise<void>;
};

/**
 * The local target `pnpm e2e` uses when `APP_CONFIG_BASE_URL` is unset: the
 * live dev server, or the port a to-be-started one will listen on. Resolved
 * once per process — the same way playwright.config.ts bakes `--port N` into
 * its webServer command — so every consumer in the run agrees on one port
 * even when nothing is running yet.
 */
function resolveLocalOsDevTargetOnce(): ReturnType<typeof localOsDevServer.resolveTarget> {
  return (stash[TARGET_KEY] ??= localOsDevServer.resolveTarget());
}

export default async function globalSetup(): Promise<void> {
  await (stash[ENSURE_KEY] ??= ensureOsUnderTest());
}

async function ensureOsUnderTest(): Promise<void> {
  const configured = process.env.APP_CONFIG_BASE_URL?.trim();
  if (configured) {
    console.log(`[e2e] deployed target ${configured} — no local dev server involved.`);
    return;
  }
  if (process.env.CI) {
    // Playwright never reuses a server in CI; we go further and never boot
    // one either — CI lanes always provide APP_CONFIG_BASE_URL, so reaching
    // this line is a lane misconfiguration, not a reason to start vite on a
    // CI runner.
    console.log("[e2e] CI without APP_CONFIG_BASE_URL — refusing to start a dev server.");
    return;
  }

  // Reuse is only sound against exactly the resolved target URL, the same
  // way Playwright's reuseExistingServer probes its one predetermined
  // target. A live server on any other port is split-brain, not a reuse.
  const target = await resolveLocalOsDevTargetOnce();
  const live = localOsDevServer.readLive();
  if (live) {
    if (live.baseUrl !== target.baseUrl) {
      throw new Error(
        `A dev server appeared at ${live.baseUrl} after this run resolved its target ` +
          `${target.baseUrl}. Re-run so config eval and globalSetup agree on one server, ` +
          `or \`pnpm dev kill\` the stray one.`,
      );
    }
    await waitForHealth(live);
    console.log(`[e2e] reusing dev server at ${live.baseUrl} (pid ${live.pid}).`);
    return;
  }

  const started = await startDevServer({ detach: true, port: target.port });
  const { baseUrl, pid, startedAt } = started;
  if (!baseUrl || !pid || !startedAt) {
    throw new Error(`Dev server start reported "${started.status}" — see ${logPath()}.`);
  }
  await waitForHealth({ baseUrl, pid, startedAt });
  console.log(
    `[e2e] started dev server at ${baseUrl} (pid ${pid}) — ` +
      `it stays up for reuse; \`pnpm dev kill\` stops it.`,
  );
}

/**
 * Recycle the local dev server between e2e files when its workerd RSS has grown
 * past the limit. Local workerd never evicts worker-loader isolates, so a long
 * suite that creates many projects climbs toward the ~4GB V8 pointer cage and
 * SIGABRTs mid-run (tasks/miniflare-oom-investigation.md); this turns that
 * monotonic climb into a sawtooth. STRICT no-op unless this run is actually
 * driving a LOCAL dev server (`readLive()` is null in CI and against a deployed
 * target) AND it is over the RSS limit — so normal small local runs and every
 * CI lane are untouched. The e2e `setupFiles` register this as an `afterAll`.
 */
export async function recycleLocalDevServerIfPressured(): Promise<void> {
  if (process.env.CI) return;
  const live = localOsDevServer.readLive();
  if (!live) return;
  const target = await resolveLocalOsDevTargetOnce();
  const normalize = (url: string) => url.replace(/\/+$/, "");
  // Only recycle the exact server this run resolved — never a stray local
  // server a developer happens to have up while testing a deployed URL.
  if (normalize(live.baseUrl) !== normalize(target.baseUrl)) return;
  if (!(await localOsDevServer.killIfMemoryPressured(live))) return;
  // It was over the limit and got killed; start a fresh, low-RSS server on the
  // same port so the next file runs against the URL setup.ts already resolved.
  const started = await startDevServer({ detach: true, port: live.port });
  if (started.baseUrl && started.pid && started.startedAt) {
    await waitForHealth({
      baseUrl: started.baseUrl,
      pid: started.pid,
      startedAt: started.startedAt,
    });
    console.log(
      `[e2e] recycled bloated dev server; fresh pid ${started.pid} at ${started.baseUrl}.`,
    );
  }
}

/**
 * Poll `${baseUrl}/api/health` until it answers 200, on the same budget as
 * the Playwright webServer timeout in playwright.config.ts: at least 10s,
 * and up to 180s measured from the server's own startedAt — a freshly
 * started server gets its full boot window, a long-lived one must answer
 * near-instantly.
 */
async function waitForHealth(server: { baseUrl: string; pid: number; startedAt: string }) {
  const url = `${server.baseUrl.replace(/\/+$/, "")}/api/health`;
  const deadline = Math.max(Date.now() + 10_000, new Date(server.startedAt).getTime() + 180_000);
  let lastFailure = "";
  do {
    try {
      // Per-probe abort so a socket that connects but never answers can't
      // outlive the deadline check below.
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastFailure = `status ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(
    `Dev server at ${server.baseUrl} (pid ${server.pid}) never became healthy ` +
      `(${url} → ${lastFailure}) — investigate ${logPath()} or \`pnpm dev kill\` it.`,
  );
}

function logPath() {
  return devServerLogPath(appRoot);
}
