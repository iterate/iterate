// THE vitest config for `pnpm test`. Three PROJECTS (vitest's own word), each a genuinely
// different execution context:
//   • unit    — in-process node, the fast lane (src/**/*.test.ts)
//   • harness — a real worker booted PER FILE via wrangler createTestHarness, driven over capnweb
//               (__tests__/**). Deep multi-step integration scenarios that want their own worker.
//   • workers — tests run INSIDE workerd next to the worker, reaching cloudflare:test controls
//               (evictDurableObject / runDurableObjectAlarm). Deliberately narrowed to the
//               HIBERNATION cases that genuinely need those controls (__workers-tests__/**).
//
// Two sibling lanes live in their own configs:
//   • `pnpm e2e`  — the vitest E2E lane (e2e/vitest.config.ts): ONE shared worker booted once by
//                   globalSetup, files in parallel — the ported live-board proofs live there.
//   • `pnpm spec` — Playwright (playwright.config.ts + specs/**): a real browser drives the hosted
//                   /demo page against a real worker.

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "harness",
          include: ["__tests__/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // one worker + sequential files: each file boots its own workerd via createTestHarness;
          // parallel boots thrash the port.
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          fileParallelism: false,
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: "./src/worker.ts",
            remoteBindings: false,
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
          // Teardown noise only: disposing a capnweb session with pager sockets still parked
          // rethrows the peer close as an unhandled rejection. Everything else stays fatal.
          onUnhandledError(error) {
            if (/RPC session|WebSocket|CONNECTION_OFFLINE|disposed/i.test(error.message ?? ""))
              return false;
          },
        },
      },
    ],
  },
});
