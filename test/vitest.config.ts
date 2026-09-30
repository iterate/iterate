// THE vitest config for the suites that drive a running worker; pick a project with `--project`
// (`pnpm e2e`, `pnpm perf` and `pnpm bench`; `pnpm test` runs the helpers' own tests). Four PROJECTS
// (vitest's own word):
//   • helpers — in-process node: the helpers' own tests (helpers/**/*.test.ts)
//   • e2e     — ONE real worker booted once by helpers/global-setup.ts (local workerd by default;
//               the DEPLOYED worker with `WORKER_BASE_URL=https://os.iterate.com`,
//               the proof that counts), every file a capnweb client at /api exactly like a production
//               client, ALL files in parallel AND all tests within a file concurrent (`--sequence.concurrent`
//               on the `e2e:run` script: a ROOT-ONLY option, see below) — every test mints its own project,
//               and what a test measures it measures on its own contexts; the run's floor is its slowest
//               TEST. A file whose rows genuinely need an order says so itself (`test.sequential` rows)
//   • perf    — the latency and throughput BUDGETS (vitest/os/perf/**/*.perf.test.ts) over the same
//               client and worker as e2e, measured ALONE: files one at a time, rows in order, never
//               beside the e2e run (in it, 16 files share the worker and a latency measures their
//               contention); the latency guard (.depot/workflows/os-latency.yml) runs it on a schedule
//   • bench   — vitest's benchmark runner (tinybench) over the same client + worker (`pnpm bench`),
//               files one at a time so scenarios never share the wire; `BENCH_OUT=<file.json>` writes
//               the raw samples
// The worker is apps/os's: `pnpm e2e`, `pnpm perf` and `pnpm bench` run its Vite build first. apps/os's
// own tests (unit, and workers inside workerd) are in apps/os/vitest.config.ts; the browser suite is
// the root Playwright one (specs/AGENTS.md).

import { fileURLToPath } from "node:url";
import {
  E2E_CI_RETRIES,
  E2E_SLOW_ROW_TIMEOUT_MS,
} from "@iterate-com/shared/test-support/e2e-policy";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { vitestReporters } from "../packages/shared/src/test-support/e2e-policy/vitest-reporters.ts";

/** Teardown/async-transport noise only: disposing a capnweb session whose peer still delivers (a
 *  deliberate move in the reconnect/unsubscribe tests, and pager sockets still parked at teardown)
 *  surfaces the peer close as an unhandled rejection. Everything else stays fatal. */
const onUnhandledError = (error: unknown): boolean | void => {
  const message = (error as { message?: string }).message ?? "";
  if (/RPC session|WebSocket|RPC_STUB_OFFLINE|disposed/i.test(message)) return false;
};

/** THE LONG POLES FIRST. vitest orders files by their cached durations, and CI has no cache, so a
 *  row that waits a real deadline would start behind the short files and end the run long after its
 *  floor. `pnpm e2e`, with rows concurrent (deployed): session's 30 s grant re-check 34 s, the
 *  dormant deadline 24 s, the 144 MiB file's sequential rows, the slow client's upload 10–15 s. A
 *  file that stops being long drops off this list. */
const LONG_POLES = [
  "vitest/os/session.e2e.test.ts",
  "vitest/os/scheduled-appends-dormant.e2e.test.ts",
  "vitest/os/isolate-ceilings-deployed.e2e.test.ts",
  "vitest/os/isolate-ceilings-slow-client.e2e.test.ts",
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
    // The sequencer is a ROOT option: vitest reads `ctx.config.sequence.sequencer`, never a project's.
    sequence: { sequencer: LongPolesFirst },
    // A ROOT option: every project's runs write the retry telemetry CI uploads. `silent` is read at
    // the root too (by the default reporter): a passing e2e or perf row still prints what it reports
    // and does not assert (perf's `[latency]` lines).
    reporters: vitestReporters,
    globalSetup: ["./vitest.global-setup.ts"],
    // Read at the ROOT: a project's own `onUnhandledError` is not consulted (vitest 4).
    onUnhandledError,
    projects: [
      {
        test: {
          name: "helpers",
          include: ["helpers/**/*.test.ts"],
          // Each test starts with the last one's spies, stubbed globals and env restored
          // (lint/test-style-rules.md), as in every workspace's config.
          restoreMocks: true,
          unstubGlobals: true,
          unstubEnvs: true,
          // `$name` titles print whole (docs/vitest-patterns.md), in each project: an inline project
          // inherits none of the root's `test` options.
          chaiConfig: { truncateThreshold: 0 },
        },
        // A module whose only platform dependency is a base class loads in node through this shim,
        // with no `vi.mock("cloudflare:workers")` in the test file (lint/test-style-rules.md).
        resolve: {
          alias: {
            "cloudflare:workers": fileURLToPath(
              new URL(
                "../packages/shared/src/test-support/cloudflare-workers-shim.ts",
                import.meta.url,
              ).href,
            ),
          },
        },
      },
      {
        test: {
          name: "e2e",
          environment: "node",
          include: ["vitest/**/*.e2e.test.ts"],
          chaiConfig: { truncateThreshold: 0 },
          // Boots the one shared worker and provides its URL (helpers/setup.ts injects it per file).
          globalSetup: ["./helpers/global-setup.ts"],
          setupFiles: ["./helpers/setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // THE SLOW ROWS (docs/testing.md#slow-rows): a row that waits out real platform time (a quiet
          // minute, a sweep, an alarm) is tagged `slow`, and a PR skips it unless it turns the slow
          // rows on or edits one: `pnpm preview e2e` picks the rows (scripts/os/slow-rows.ts). A tag this
          // list does not define fails its row.
          tags: [
            {
              name: "slow",
              description:
                "Waits out real platform time; a PR skips it unless it turns the slow rows on or edits one",
              timeout: E2E_SLOW_ROW_TIMEOUT_MS,
            },
          ],
          strictTags: true,
          // One retry in CI only (docs/testing.md: retries are measured, never silent — a local flake
          // should be SEEN, not absorbed). Each test is self-contained (fresh ctx).
          retry: process.env.CI ? E2E_CI_RETRIES : 0,
          // FILES IN PARALLEL: every test mints its own project (helpers/client.ts `freshCtx` carries
          // the run's id and the worker process's slot), so nothing two files touch is shared but the
          // worker itself — which is the thing under test. The cap is an I/O one: these are round trips
          // to a remote worker, not CPU (the 4-vCPU CI box idles at 1–8 % during the run), and 8
          // workers packed 33 files into a 100 s critical path above the longest pole; 16 reaches the
          // pole (measured 2026-09-21: 8 → 114–120 s, 16 → the pole + a few seconds).
          maxWorkers: process.env.CI ? 16 : undefined,
          fileParallelism: true,
          // TESTS IN ONE FILE CONCURRENT TOO: each one opens its own sessions (helpers/client.ts keeps
          // them per test, helpers/setup.ts disposes that test's alone) against its own project, so the
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
          include: ["vitest/os/perf/**/*.perf.test.ts"],
          chaiConfig: { truncateThreshold: 0 },
          globalSetup: ["./helpers/global-setup.ts"],
          // vitest/os/perf/setup.ts: what a failed row leaves for the latency guard beside its message
          setupFiles: ["./helpers/setup.ts", "./vitest/os/perf/setup.ts"],
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
            include: ["vitest/os/bench/**/*.bench.ts"],
            outputJson: process.env.BENCH_OUT,
          },
          globalSetup: ["./helpers/global-setup.ts"],
          setupFiles: ["./helpers/setup.ts"],
          testTimeout: 300_000,
          hookTimeout: 300_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
