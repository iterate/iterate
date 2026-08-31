// e2e/vitest.config.ts — the vitest E2E lane (`pnpm e2e`), shaped after apps/os: ONE worker booted
// once by globalSetup, addressed by URL, shared by every file. Tests speak capnweb over WebSocket to
// /api exactly like a production client, so the SAME suite would hold against a live Cloudflare
// deployment (or a self-hosted celld) — nothing here reaches into workerd internals. Files run in
// parallel (each test takes a fresh ctx = its own Durable Object); tests within a file run
// sequentially so the per-test session-dispose (support/setup.ts) can't race a sibling.
//
// Two sibling lanes live elsewhere: fast in-process unit tests (../vitest.config.ts) and the
// hibernation cases that genuinely need workerd-internal controls (../__workers-tests__, pool-workers).
// Browser E2E is Playwright (../playwright.config.ts).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "e2e",
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    // Boots the one shared worker and provides its URL (support/setup.ts injects it per file).
    globalSetup: ["./e2e/support/global-setup.ts"],
    setupFiles: ["./e2e/support/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One retry in CI only (the docs/testing.md policy: retries are measured, never silent — and a
    // local flake should be SEEN, not absorbed). Each test is self-contained (fresh ctx).
    retry: process.env.CI ? 1 : 0,
    fileParallelism: true,
    sequence: { concurrent: false },
    // Teardown/async-transport noise only: dropping a capnweb session whose peer still delivers (a
    // deliberate move in the reconnect/unsubscribe tests) surfaces the peer close as an unhandled
    // rejection. Everything else stays fatal. (Same filter as the workers lane in ../vitest.config.ts.)
    onUnhandledError(error) {
      if (/RPC session|WebSocket|CONNECTION_OFFLINE|disposed/i.test(error.message ?? ""))
        return false;
    },
  },
});
