// THE vitest config — the ONE way to run everything (`pnpm test`); pick a lane with `--project`.
// Five PROJECTS (vitest's own word), each a genuinely different execution context:
//   • unit    — in-process node, the fast lane (src/**/*.test.ts)
//   • workers — INSIDE workerd next to the worker via @cloudflare/vitest-plugin, for the hibernation
//               cases that genuinely need cloudflare:test controls (__workers-tests__/**). The worker
//               under test is src/worker.ts, bundled by the plugin — SELF.fetch, never
//               `import worker from "../src/worker.ts"`.
//   • e2e     — ONE real worker booted once by e2e/support/global-setup.ts (local workerd by default;
//               the DEPLOYED worker with `WORKER_BASE_URL=https://os.iterate2.com`,
//               the proof that counts), every file a capnweb client at /api exactly like a production
//               client, ALL files in parallel — every test mints its own project, and what a test measures
//               it measures on its own contexts; tests within a file sequential (the per-test
//               session-dispose in support/setup.ts must not race a sibling)
//   • bench   — vitest's benchmark runner (tinybench) over the same client + worker (`pnpm bench`),
//               files one at a time so scenarios never share the wire; `BENCH_OUT=<file.json>` writes
//               the raw samples
// Every project runs after THE BUILD (vitest.global-setup.ts → scripts/build.ts): the generated modules
// the worker imports. Browser E2E is Playwright (playwright.config.ts + specs/**).

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, type Plugin } from "vitest/config";

// A `.sql` file imports as its text — what wrangler's `rules` (type `Text` for the .sql glob) do
// for the worker's own bundle (src/worker.ts applies src/control-plane.sql at boot), done here for
// the lanes Vite loads the module in (node, and workerd through the plugin's module runner).
const sqlAsText: Plugin = {
  name: "sql-as-text",
  transform(code, id) {
    if (id.endsWith(".sql")) return { code: `export default ${JSON.stringify(code)};`, map: null };
  },
};

/** Teardown/async-transport noise only: disposing a capnweb session whose peer still delivers (a
 *  deliberate move in the reconnect/unsubscribe tests, and pager sockets still parked at teardown)
 *  surfaces the peer close as an unhandled rejection; and the workers pool closing its module
 *  resolver while a saga a test started (a project's birth seeding its config repo) still runs in
 *  the background after the test ended — `EnvironmentTeardownError`, the harness's, never the
 *  worker's. Everything else stays fatal. */
const onUnhandledError = (error: unknown): boolean | void => {
  const message = (error as { message?: string }).message ?? "";
  if (/RPC session|WebSocket|RPC_STUB_OFFLINE|disposed/i.test(message)) return false;
  if ((error as { name?: string }).name === "EnvironmentTeardownError") return false;
  if (/EnvironmentTeardownError|Closing rpc while/.test(message)) return false;
};

export default defineConfig({
  test: {
    globalSetup: ["./vitest.global-setup.ts"],
    // Read at the ROOT: a project's own `onUnhandledError` is not consulted (vitest 4).
    onUnhandledError,
    projects: [
      {
        plugins: [sqlAsText],
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "examples/**/*.test.ts", "scripts/*.test.ts"],
          // The edge and DO modules reach the control plane, whose OAuth provider imports
          // cloudflare:workers; inlined so the unit tests' `vi.mock("cloudflare:workers")` covers it.
          server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
        },
      },
      {
        plugins: [
          sqlAsText,
          cloudflareTest({
            main: "./src/worker.ts",
            wrangler: { configPath: "./wrangler.test.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          include: ["__workers-tests__/**/*.test.ts"],
          // First test pays workerd boot + the 200-client attach storm (the cloudflare-os
          // cold-start lesson, scaled up).
          testTimeout: 120_000,
          hookTimeout: 120_000,
          onUnhandledError,
        },
      },
      {
        test: {
          name: "e2e",
          environment: "node",
          include: ["e2e/**/*.e2e.test.ts"],
          // Boots the one shared worker and provides its URL (support/setup.ts injects it per file).
          globalSetup: ["./e2e/support/global-setup.ts"],
          setupFiles: ["./e2e/support/setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // One retry in CI only (docs/testing.md: retries are measured, never silent — a local flake
          // should be SEEN, not absorbed). Each test is self-contained (fresh ctx).
          retry: process.env.CI ? 1 : 0,
          // FILES IN PARALLEL: every test mints its own project (client.ts `freshCtx` carries the run's
          // id and the worker process's slot), so nothing two files touch is shared but the worker
          // itself — which is the thing under test. The cap is an I/O one: these are round trips to a
          // remote worker, not CPU, so the runner's cpus-1 default is the wrong shape on a CI box.
          maxWorkers: process.env.CI ? 8 : undefined,
          fileParallelism: true,
          sequence: { concurrent: false },
          onUnhandledError,
        },
      },
      {
        test: {
          name: "bench",
          environment: "node",
          include: [],
          benchmark: {
            include: ["bench/**/*.bench.ts"],
            outputJson: process.env.BENCH_OUT,
          },
          globalSetup: ["./e2e/support/global-setup.ts"],
          setupFiles: ["./e2e/support/setup.ts"],
          testTimeout: 300_000,
          hookTimeout: 300_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
