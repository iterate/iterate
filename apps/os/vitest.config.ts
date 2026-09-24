// THE vitest config; pick a project with `--project` (`pnpm test` runs unit + workers, `pnpm e2e`,
// `pnpm perf` and `pnpm bench` the other three). Five PROJECTS (vitest's own word), each a genuinely
// different execution context:
//   • unit    — in-process node, the fast suite (src/**/*.test.ts)
//   • workers — INSIDE workerd next to the worker via @cloudflare/vitest-plugin, for the hibernation
//               cases that genuinely need cloudflare:test controls (__workers-tests__/**). The worker
//               under test is Vite's built dist/server/index.js — `exports.default.fetch`
//               from cloudflare:workers, never a source import of the Start entry.
//   • e2e     — ONE real worker booted once by e2e/support/global-setup.ts (local workerd by default;
//               the DEPLOYED worker with `WORKER_BASE_URL=https://os.iterate.com`,
//               the proof that counts), every file a capnweb client at /api exactly like a production
//               client, ALL files in parallel AND all tests within a file concurrent (`--sequence.concurrent`
//               on the `e2e:run` script: a ROOT-ONLY option, see below) — every test mints its own project,
//               and what a test measures it measures on its own contexts; the run's floor is its slowest
//               TEST. A file whose rows genuinely need an order says so itself (`test.sequential` rows)
//   • perf    — the latency and throughput BUDGETS (perf/**/*.perf.test.ts) over the same client and
//               worker as e2e, measured ALONE: files one at a time, rows in order, never beside the
//               e2e run (in it, 16 files share the worker and a latency measures their contention);
//               the latency guard (.depot/workflows/os-latency.yml) runs it on a schedule
//   • bench   — vitest's benchmark runner (tinybench) over the same client + worker (`pnpm bench`),
//               files one at a time so scenarios never share the wire; `BENCH_OUT=<file.json>` writes
//               the raw samples
// Package test scripts run the Vite build before Vitest starts. Global setup refreshes generated
// modules for unit tests and fixtures. Browser E2E is the root Playwright suite (specs/AGENTS.md).

import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { E2E_CI_RETRIES } from "@iterate-com/shared/test-support/e2e-policy";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

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

/** THE LONG POLES FIRST. vitest orders files by their cached durations, and CI has no cache — so the
 *  row that waits a real deadline started after ninety seconds of short files and the run ended at
 *  170 s instead of its floor (measured 2026-09-21). These files start first, the longest first;
 *  everything else follows vitest's own order, which runs every unit file before the first workers
 *  file. `pnpm test` (unit + workers, 7 slots in CI), 2026-09-24: the facet-push watchdog 62 s (the
 *  run's floor), oauth's four 30 s re-checks 34–36 s each, a file apiece (oauth-support.ts), the
 *  CPU-bound memory children 20 s beside those idle waits; alarm-and-pins (42 s, fixed sub-second
 *  waits) starts in the first free slot.
 *  `pnpm e2e`, with rows concurrent (deployed): context-watchdog's two eviction windows 37 s (it
 *  started 13 s in behind the first sixteen files), session's 30 s grant re-check 34 s, the dormant
 *  deadline 24 s, the 144 MiB file's sequential rows, the slow client's upload 10–15 s. A file that
 *  stops being long drops off this list. */
const LONG_POLES = [
  "__workers-tests__/facet-push-timeout-heals.test.ts",
  "__workers-tests__/oauth-recheck-deploy-reset.test.ts",
  "__workers-tests__/oauth-recheck-no-project.test.ts",
  "__workers-tests__/oauth-recheck-revoked.test.ts",
  "__workers-tests__/oauth-recheck-membership.test.ts",
  "src/stream/memory-budget.test.ts",
  "e2e/context-watchdog.e2e.test.ts",
  "e2e/session.e2e.test.ts",
  "e2e/scheduled-appends-dormant.e2e.test.ts",
  "e2e/isolate-ceilings-deployed.e2e.test.ts",
  "e2e/isolate-ceilings-slow-client.e2e.test.ts",
];
class LongPolesFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const ordered = await super.sort(files);
    const rank = (spec: TestSpecification) =>
      LONG_POLES.findIndex((pole) => spec.moduleId.endsWith(pole));
    const poles = ordered.filter((spec) => rank(spec) >= 0).sort((a, b) => rank(a) - rank(b));
    return [...poles, ...ordered.filter((spec) => rank(spec) < 0)];
  }
}

export default defineConfig({
  test: {
    // The sequencer is a ROOT option — vitest reads `ctx.config.sequence.sequencer`, never a project's;
    // it orders every project's files, and one list serves all three that name a pole.
    sequence: { sequencer: LongPolesFirst },
    // SEVEN SLOTS FOR `pnpm test` IN CI, on the 4-vCPU Test runner where vitest's default is three
    // (the CPUs less one). Its long files wait real timers at no CPU — oauth's re-checks, the
    // facet-push watchdog — and at three slots they queued behind each other while the job averaged
    // 23 % CPU. At seven, every long pole starts at once. A ROOT option: unit and workers run as one
    // group, which vitest refuses to split between two `maxWorkers`; e2e sets its own.
    maxWorkers: process.env.CI ? 7 : undefined,
    globalSetup: ["./vitest.global-setup.ts"],
    // Read at the ROOT: a project's own `onUnhandledError` is not consulted (vitest 4).
    onUnhandledError,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "scripts/*.test.ts"],
          // The edge and DO modules reach the control plane, whose OAuth provider imports
          // cloudflare:workers; inlined so the alias below covers it.
          server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
        },
        // A module whose only platform dependency is a base class loads in node through this shim,
        // with no `vi.mock("cloudflare:workers")` in the test file (lint/test-style-rules.md). Start's
        // server entry, generated by the Vite build, is a stand-in page here for the same reason.
        resolve: {
          alias: {
            "cloudflare:workers": fileURLToPath(
              new URL("./src/test/cloudflare-workers-shim.ts", import.meta.url),
            ),
            "@tanstack/react-start/server-entry": fileURLToPath(
              new URL("./src/test/start-server-entry-shim.ts", import.meta.url),
            ),
          },
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: "./dist/server/index.js",
            wrangler: { configPath: "./wrangler.test.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          include: ["__workers-tests__/**/*.test.ts", "../agents/__workers-tests__/**/*.test.ts"],
          // First test pays workerd boot + the 200-client attach storm (the cloudflare-os
          // cold-start lesson, scaled up).
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: "e2e",
          environment: "node",
          include: ["e2e/**/*.e2e.test.ts", "../agents/e2e/**/*.e2e.test.ts"],
          // Boots the one shared worker and provides its URL (support/setup.ts injects it per file).
          globalSetup: ["./e2e/support/global-setup.ts"],
          setupFiles: ["./e2e/support/setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // One retry in CI only (docs/testing.md: retries are measured, never silent — a local flake
          // should be SEEN, not absorbed). Each test is self-contained (fresh ctx).
          retry: process.env.CI ? E2E_CI_RETRIES : 0,
          // FILES IN PARALLEL: every test mints its own project (client.ts `freshCtx` carries the run's
          // id and the worker process's slot), so nothing two files touch is shared but the worker
          // itself — which is the thing under test. The cap is an I/O one: these are round trips to a
          // remote worker, not CPU (the 4-vCPU CI box idles at 1–8 % during the run), and 8 workers
          // packed 33 files into a 100 s critical path above the longest pole; 16 reaches the pole
          // (measured 2026-09-21: 8 → 114–120 s, 16 → the pole + a few seconds).
          maxWorkers: process.env.CI ? 16 : undefined,
          fileParallelism: true,
          // TESTS IN ONE FILE CONCURRENT TOO: each one opens its own sessions (support/client.ts keeps
          // them per test, support/setup.ts disposes that test's alone) against its own project, so the
          // only thing two rows share is the worker under test. A file that reads worker-global state —
          // its own worker's logs, one seeded context it also resets — marks those rows `test.sequential`.
          // `sequence.concurrent` is ROOT-ONLY (vitest copies the root value into every project and
          // ignores the project's — a project-level `sequence: { concurrent: true }` here did nothing,
          // 2026-09-21), so the `e2e:run` script passes `--sequence.concurrent`. `maxConcurrency` IS per
          // project: the default 5 would run a 21-row file in five waves.
          maxConcurrency: 32,
        },
      },
      {
        test: {
          name: "perf",
          environment: "node",
          include: ["perf/**/*.perf.test.ts"],
          globalSetup: ["./e2e/support/global-setup.ts"],
          setupFiles: ["./e2e/support/setup.ts"],
          testTimeout: 240_000,
          hookTimeout: 120_000,
          // ALONE ON THE WIRE: one file at a time, and `perf:run` passes no `--sequence.concurrent`,
          // so its rows run in order. No retry: each budget already holds for the median of its
          // rounds, and a miss is a number to read (the soak tallies it), not one to re-roll.
          fileParallelism: false,
          retry: 0,
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
