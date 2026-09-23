// THE vitest config — the ONE way to run everything (`pnpm test`); pick a lane with `--project`.
// Five PROJECTS (vitest's own word), each a genuinely different execution context:
//   • unit    — in-process node, the fast lane (src/**/*.test.ts)
//   • workers — INSIDE workerd next to the worker via @cloudflare/vitest-plugin, for the hibernation
//               cases that genuinely need cloudflare:test controls (__workers-tests__/**). The worker
//               under test is src/worker.ts, bundled by the plugin — SELF.fetch, never
//               `import worker from "../src/worker.ts"`.
//   • e2e     — ONE real worker booted once by e2e/support/global-setup.ts (local workerd by default;
//               the DEPLOYED worker with `WORKER_BASE_URL=https://os.iterate.com`,
//               the proof that counts), every file a capnweb client at /api exactly like a production
//               client, ALL files in parallel AND all tests within a file concurrent (`--sequence.concurrent`
//               on the `e2e` script: a ROOT-ONLY option, see below) — every test mints its own project,
//               and what a test measures it measures on its own contexts; the run's floor is its slowest
//               TEST. A file whose rows genuinely need an order says so itself (`describe.sequential`)
//   • bench   — vitest's benchmark runner (tinybench) over the same client + worker (`pnpm bench`),
//               files one at a time so scenarios never share the wire; `BENCH_OUT=<file.json>` writes
//               the raw samples
// Every project runs after THE BUILD (vitest.global-setup.ts → scripts/build.ts): the generated modules
// the worker imports. Browser E2E is Playwright (playwright.config.ts + specs/**).

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, type Plugin } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

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

/** THE LONG POLES FIRST. vitest orders files by their cached durations, and CI has no cache — so the
 *  row that waits a real deadline started after ninety seconds of short files and the run ended at
 *  170 s instead of its floor (measured 2026-09-21). These files start in slot one, longest first;
 *  everything else follows vitest's own order. With rows concurrent the poles are (deployed, 2026-09-22):
 *  session's 30 s grant re-check 34 s, the dormant deadline 24 s, the 144 MiB file's sequential rows,
 *  the slow client's upload 10–15 s, then nothing above 12 s. A file that stops being long drops off
 *  this list. */
const LONG_POLES = [
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
    // it orders every project's files, and only the e2e files are named in LONG_POLES.
    sequence: { sequencer: LongPolesFirst },
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
          include: ["__workers-tests__/**/*.test.ts", "../agents/__workers-tests__/**/*.test.ts"],
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
          include: ["e2e/**/*.e2e.test.ts", "../agents/e2e/**/*.e2e.test.ts"],
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
          // remote worker, not CPU (the 4-vCPU CI box idles at 1–8 % during the run), and 8 workers
          // packed 33 files into a 100 s critical path above the longest pole; 16 reaches the pole
          // (measured 2026-09-21: 8 → 114–120 s, 16 → the pole + a few seconds).
          maxWorkers: process.env.CI ? 16 : undefined,
          fileParallelism: true,
          // TESTS IN ONE FILE CONCURRENT TOO: each one opens its own sessions (support/client.ts keeps
          // them per test, support/setup.ts disposes that test's alone) against its own project, so the
          // only thing two rows share is the worker under test. A file that reads worker-global state —
          // its own worker's logs, one seeded context it also resets — marks itself `describe.sequential`.
          // `sequence.concurrent` is ROOT-ONLY (vitest copies the root value into every project and
          // ignores the project's — a project-level `sequence: { concurrent: true }` here did nothing,
          // 2026-09-21), so the `e2e` script passes `--sequence.concurrent`. `maxConcurrency` IS per
          // project: the default 5 would run a 21-row file in five waves.
          maxConcurrency: 32,
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
