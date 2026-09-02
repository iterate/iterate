// THE vitest config for `pnpm test`. Two PROJECTS (vitest's own word), each a genuinely different
// execution context:
//   • unit    — in-process node, the fast lane (src/**/*.test.ts)
//   • workers — tests run INSIDE workerd next to the worker, reaching cloudflare:test controls
//               (evictDurableObject / runDurableObjectAlarm). Deliberately narrowed to the
//               HIBERNATION cases that genuinely need those controls (__workers-tests__/**).
//
// Everything that needs the REAL worker over its public door lives in the e2e lane, its own config:
//   • `pnpm e2e`  — e2e/vitest.config.ts: ONE shared worker booted once by globalSetup, every
//                   <primitive>-<claim>.e2e.test.ts a capnweb client at /api, files in parallel.
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
        plugins: [
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
