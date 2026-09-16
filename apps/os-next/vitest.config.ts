// THE vitest config — the ONE way to run everything (`pnpm test`); pick a lane with `--project`.
// Four PROJECTS (vitest's own word), each a genuinely different execution context:
//   • unit    — in-process node, the fast lane (src/**/*.test.ts)
//   • workers — INSIDE workerd next to the worker via @cloudflare/vitest-plugin, for the hibernation
//               cases that genuinely need cloudflare:test controls (__workers-tests__/**). The worker
//               under test is THE BUILT ONE (dist/server/index.js, `vite build`): the console's
//               Start server entry resolves only inside the Vite build, so the lane drives the bundle
//               a deploy ships — SELF.fetch, never `import worker from "../src/worker.ts"`.
//   • e2e     — ONE real worker booted once by e2e/support/global-setup.ts (local workerd by default;
//               the DEPLOYED worker with `WORKER_BASE_URL=https://os.iterate2.com`,
//               the proof that counts), every file a capnweb client at /api exactly like a production
//               client, files in parallel, tests within a file sequential (the per-test session-dispose
//               in support/setup.ts must not race a sibling)
//   • bench   — vitest's benchmark runner (tinybench) over the same client + worker (`pnpm bench`),
//               files one at a time so scenarios never share the wire; `BENCH_OUT=<file.json>` writes
//               the raw samples
// The injected SDK is a virtual module (scripts/vite-plugin-processor-sdk.ts) every project resolves;
// the workers and e2e lanes also need the Vite build (dist/, gitignored), run once by the root
// globalSetup — skipped when only the unit lane runs. Browser E2E is Playwright (playwright.config.ts + specs/**).

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { processorSdkModules } from "./scripts/vite-plugin-processor-sdk.ts";

/** Teardown/async-transport noise only: disposing a capnweb session whose peer still delivers (a
 *  deliberate move in the reconnect/unsubscribe tests, and pager sockets still parked at teardown)
 *  surfaces the peer close as an unhandled rejection. Everything else stays fatal. */
const onUnhandledError = (error: unknown): boolean | void => {
  const message = (error as { message?: string }).message ?? "";
  if (/RPC session|WebSocket|RPC_STUB_OFFLINE|disposed/i.test(message)) return false;
};

export default defineConfig({
  test: {
    globalSetup: ["./vitest.global-setup.ts"],
    projects: [
      {
        plugins: [processorSdkModules()],
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "examples/**/*.test.ts"],
          // The edge and DO modules reach the control plane, whose OAuth provider imports
          // cloudflare:workers; inlined so the unit tests' `vi.mock("cloudflare:workers")` covers it.
          server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
        },
      },
      {
        plugins: [
          processorSdkModules(),
          cloudflareTest({
            main: "./dist/server/index.js", // the Vite build (vitest.global-setup.ts)
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
        plugins: [processorSdkModules()],
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
          fileParallelism: true,
          sequence: { concurrent: false },
          onUnhandledError,
        },
      },
      {
        plugins: [processorSdkModules()],
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
