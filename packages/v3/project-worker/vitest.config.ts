// THE ONE test config. Three PROJECTS (vitest's own word), one command (`pnpm test`) — the
// cook-down of what used to be three configs + three scripts. Each project is a genuinely
// different execution context, not a taste split:
//   • unit    — in-process node, the fast lane (src/**/*.test.ts)
//   • harness — real worker booted locally via wrangler createTestHarness, driven over capnweb
//               exactly like production (__tests__/**/*.test.ts)
//   • workers — tests run INSIDE workerd next to the worker, reaching cloudflare:test DO
//               controls (evictDurableObject) — the hibernation lane (__workers-tests__/**)

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
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
