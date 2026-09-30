// THE vitest config; pick a project with `--project` (`pnpm test` runs unit + workers, `pnpm e2e`,
// `pnpm perf` and `pnpm bench` the other three). Five PROJECTS (vitest's own word), each a genuinely
// different execution context:
//   • unit    — in-process node, the fast suite (src/**/*.test.ts, and the e2e fixtures' own tests)
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

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import {
  E2E_CI_RETRIES,
  E2E_SLOW_ROW_TIMEOUT_MS,
} from "@iterate-com/shared/test-support/e2e-policy";
import JSON5 from "json5";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { vitestReporters } from "../../packages/shared/src/test-support/e2e-policy/vitest-reporters.ts";
import { readWranglerBase } from "./scripts/generate-wrangler-config.ts";

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

/** THE LONG POLES FIRST. vitest orders files by their cached durations, and CI has no cache, so a
 *  row that waits a real deadline would start behind the short files and end the run long after its
 *  floor (at 170 s, measured 2026-09-21). These files start first, the longest first;
 *  then the other workers files, back to back, so a runner that ends one keeps its runtime for the
 *  next (the workers project's `isolate: false`); then the unit files, in vitest's own order.
 *  `pnpm test` (unit + workers, 7 slots in CI), 2026-09-24: the facet-push watchdog 60 s (the
 *  run's floor; the run ends at 67 s, its workers files starting 4 s in), oauth's four 30 s
 *  re-checks 31–36 s each, a file apiece (oauth-support.ts), personal access tokens' 30 s re-check
 *  35 s (one row, measured at 3 slots), the CPU-bound memory children 20 s beside those idle waits.
 *  `pnpm e2e`, with rows concurrent (deployed): session's 30 s grant re-check 34 s, the dormant
 *  deadline 24 s, the 144 MiB file's sequential rows, the slow client's upload 10–15 s. A file that
 *  stops being long drops off this list. */
const LONG_POLES = [
  "__workers-tests__/facet-push-timeout-heals.test.ts",
  // The same 60 s watchdog, its restart cutting off a sibling push: ~62 s (measured 2026-09-25).
  "__workers-tests__/facet-timeout-restart-heals-sibling-push.test.ts",
  // Fixed sub-second waits that add up: 41 s in CI (measured 2026-09-27), longer than every file
  // but the two watchdogs'.
  "__workers-tests__/alarm-and-pins.test.ts",
  "__workers-tests__/oauth-recheck-platform-failure.test.ts",
  "__workers-tests__/personal-access-tokens.test.ts",
  "__workers-tests__/oauth-recheck-no-project.test.ts",
  "__workers-tests__/oauth-recheck-revoked.test.ts",
  "__workers-tests__/oauth-recheck-membership.test.ts",
  // Every facet row but the watchdog's, in one worker: 19–21 s (measured locally 2026-09-26).
  "__workers-tests__/facets.test.ts",
  "src/stream/memory-budget.test.ts",
  "e2e/session.e2e.test.ts",
  "e2e/scheduled-appends-dormant.e2e.test.ts",
  "e2e/isolate-ceilings-deployed.e2e.test.ts",
  "e2e/isolate-ceilings-slow-client.e2e.test.ts",
];
/** FIRST OF ALL, IN A RUNTIME NOTHING RAN IN YET. agent-revive evicts a context whose facet it has
 *  just aborted mid model call. In a runtime an earlier file warmed, that eviction can wait out the
 *  claim's 20 s alarm or `evictDurableObject`'s 30 s bound: a race in the eviction, not state an
 *  earlier file left, since it fails as often with fresh-file.ts doing nothing. Repro, in apps/os
 *  with the unit project looping beside it (3 runs in 8 failed, measured 2026-09-27):
 *  `vitest run --project workers --maxWorkers=1 --sequence.seed=7
 *  -t "^(a key bound to projects|KILLED MID-CALL)" __workers-tests__/connect-your-account.test.ts
 *  ../agents/__workers-tests__/agent-revive.test.ts`. The race is
 *  https://github.com/iterate/iterate/issues/3291; this entry goes once that repro passes every time. */
const FRESH_RUNTIME_FIRST = ["apps/agents/__workers-tests__/agent-revive.test.ts"];

class LongPolesFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    // `--sequence.seed=<n>` puts every file in an order drawn from n instead: the check that no file
    // depends on what the files before it in its runtime did (`pnpm test -- --sequence.seed=7`).
    // vitest sets no seed of its own unless `--sequence.shuffle` shuffles the tests too.
    const { seed } = this.ctx.config.sequence;
    if (seed !== undefined) return seededOrder(files, seed);
    const ordered = await super.sort(files);
    const rank = (spec: TestSpecification) =>
      LONG_POLES.findIndex((pole) => spec.moduleId.endsWith(pole));
    const fresh = ordered.filter((spec) =>
      FRESH_RUNTIME_FIRST.some((file) => spec.moduleId.endsWith(file)),
    );
    const poles = ordered.filter((spec) => rank(spec) >= 0).sort((a, b) => rank(a) - rank(b));
    const rest = ordered.filter((spec) => rank(spec) < 0 && !fresh.includes(spec));
    const sharingRuntimes = rest.filter((spec) => spec.project.config.isolate === false);
    return [
      ...fresh,
      ...poles,
      ...sharingRuntimes,
      ...rest.filter((spec) => !sharingRuntimes.includes(spec)),
    ];
  }
}

/** EACH WORKERS RUNTIME'S STORAGE: a directory per Miniflare (its `resourcePersistencePath`, which
 *  patches/@cloudflare__vitest-plugin@1.3.2.patch lets through), so the pool knows where the files
 *  are and can empty them between two files (`TEST_STORAGE`, __workers-tests__/empty-runtime.ts). A
 *  runtime left alone keeps its storage in a temporary directory of Miniflare's own, where nothing
 *  outside workerd can reach it. Removed when vitest exits. */
const runtimeStorageDirs: string[] = [];
process.on("exit", () => {
  for (const dir of runtimeStorageDirs) rmSync(dir, { recursive: true, force: true });
});
function runtimeStorage() {
  const dir = mkdtempSync(join(tmpdir(), "os-workers-storage-"));
  runtimeStorageDirs.push(dir);
  return {
    dir,
    /** Every object's file gone: the Durable Objects' SQLite and their facets' (`do/`), D1's, KV's
     *  and the Cache API's, with their blobs. Each namespace's `metadata.sqlite` stays: it is the
     *  alarm schedule workerd holds open, which `reset()` has just emptied. `force`: an aborted
     *  object's SQLite, closing, can delete its own `-wal` or `-journal` after the listing. */
    empty() {
      for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && !/^metadata\.sqlite(-wal|-shm)?$/.test(entry.name))
          rmSync(join(entry.parentPath, entry.name), { force: true });
      }
      return new Response(null, { status: 204 });
    },
  };
}

/** THE WORKERS SUITE'S WRANGLER CONFIG, derived from wrangler.base.jsonc (`readWranglerBase`, the
 *  template every deployment's and preview's config derives from) so the two cannot disagree: the
 *  compatibility date and flags, the Durable Objects and their `exports`, the LOADER, the assets and
 *  the local D1, KV and R2 are the base's. What differs is written down in two places: the keys
 *  wrangler.test.jsonc sets over the base (the suite's configuration), and here, the bindings
 *  wrangler's local runtime can only proxy to the real products — `ai`, `browser` and `artifacts`,
 *  for which vitest-pool-workers would start a remote proxy session at boot (an account to pick, a
 *  network to reach). The suite never calls `itx.ai`, `itx.browser` or `itx.cfArtifacts`, and
 *  `env.AI`, `env.BROWSER` and `env.ARTIFACTS` are undefined in it; the e2e suite boots from the
 *  Vite-built config with them (e2e/support/worker-config.ts). The code under test is Vite's built
 *  entry. Written once per vitest process to a directory of its own, the base's relative paths made
 *  absolute: wrangler resolves them, and reads a `.dev.vars`, beside the config file. */
let workersWranglerConfig: string | undefined;
function workersWranglerConfigPath() {
  if (workersWranglerConfig) return workersWranglerConfig;
  const { ai: _ai, browser: _browser, artifacts: _artifacts, ...base } = readWranglerBase();
  const fromApp = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "os-workers-config-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  workersWranglerConfig = join(dir, "wrangler.json");
  writeFileSync(
    workersWranglerConfig,
    JSON.stringify({
      ...base,
      ...JSON5.parse(readFileSync(fromApp("./wrangler.test.jsonc"), "utf8")),
      main: fromApp("./dist/server/index.js"),
      assets: { ...base.assets, directory: fromApp(base.assets.directory) },
      d1_databases: base.d1_databases.map((database: { migrations_dir: string }) => ({
        ...database,
        migrations_dir: fromApp(database.migrations_dir),
      })),
    }),
  );
  return workersWranglerConfig;
}

/** `files` by module id, then shuffled (Fisher–Yates) with mulberry32 seeded by `seed`: one seed, one
 *  order, on any machine. */
function seededOrder(files: TestSpecification[], seed: number) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const order = [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** THE WORKERS SUITE'S GITHUB APP — iterate's App at a fake GitHub (github.test,
 *  __workers-tests__/integrations.test.ts), bound here rather than in wrangler.test.jsonc
 *  because its key is a throwaway generated per run: no private key is ever in git. PKCS#1, the
 *  shape GitHub hands out; the public half is the fake's. */
const WORKERS_GITHUB_APP_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

export default defineConfig({
  test: {
    // The sequencer is a ROOT option — vitest reads `ctx.config.sequence.sequencer`, never a project's;
    // it orders every project's files, and one list serves all three that name a pole.
    sequence: { sequencer: LongPolesFirst },
    // SEVEN SLOTS FOR `pnpm test` IN CI. Its long files wait real timers at no CPU — oauth's
    // re-checks, personal access tokens' re-check, the facet-push watchdog — and at three slots
    // (vitest's default on a 4-vCPU runner, the CPUs less one) they queued behind each other while the
    // job averaged 23 % CPU. At seven, every long pole starts at once. Pinned, not left to the
    // default, so a change of runner (.depot/workflows/test.yml) does not change the slots. A ROOT
    // option: unit and workers run as one group, which vitest refuses to split between two
    // `maxWorkers`; e2e sets its own.
    maxWorkers: process.env.CI ? 7 : undefined,
    // A ROOT option: every project's runs, e2e's included, write the retry telemetry CI uploads.
    // `silent` is read at the root too (by the default reporter), so `pnpm test` passes
    // `--silent=passed-only` for unit and workers alone: a passing e2e or perf row still prints
    // what it reports and does not assert (perf's `[latency]` lines).
    reporters: vitestReporters,
    globalSetup: ["./vitest.global-setup.ts"],
    // Read at the ROOT: a project's own `onUnhandledError` is not consulted (vitest 4).
    onUnhandledError,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "scripts/*.test.ts", "e2e/support/**/*.test.ts"],
          // Each test starts with the last one's spies, stubbed globals and env restored
          // (lint/test-style-rules.md), as in every workspace's config. Not in e2e, whose rows run
          // concurrently: a restore before one row would undo a sibling's.
          restoreMocks: true,
          unstubGlobals: true,
          unstubEnvs: true,
          // `$name` titles print whole (docs/vitest-patterns.md), in each project: an inline project
          // inherits none of the root's `test` options.
          chaiConfig: { truncateThreshold: 0 },
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
              new URL(
                "../../packages/shared/src/test-support/cloudflare-workers-shim.ts",
                import.meta.url,
              ),
            ),
            "@tanstack/react-start/server-entry": fileURLToPath(
              new URL("./src/test/start-server-entry-shim.ts", import.meta.url),
            ),
          },
        },
      },
      {
        plugins: [
          // The control plane's D1 starts empty in every test file (empty-runtime.ts empties it):
          // the migrations, read here in node, are applied by the setup file below, as wrangler
          // applies them to a deployment's (https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/#d1).
          // Called once per runtime: each gets its own storage directory.
          cloudflareTest(async () => {
            const storage = runtimeStorage();
            return {
              wrangler: { configPath: workersWranglerConfigPath() },
              miniflare: {
                resourcePersistencePath: storage.dir,
                serviceBindings: { TEST_STORAGE: () => storage.empty() },
                bindings: {
                  TEST_MIGRATIONS: await readD1Migrations(
                    fileURLToPath(new URL("./src/control-plane/db/migrations", import.meta.url)),
                  ),
                  APP_CONFIG_INTEGRATIONS__GITHUB: JSON.stringify({
                    appId: "github-test-app",
                    appSlug: "iterate-test",
                    oauthClientId: "petshop-default",
                    oauthClientSecret: "petshop-default-secret",
                    privateKey: WORKERS_GITHUB_APP_KEY.privateKey,
                    webhookSecret: "github-test-webhook-secret",
                    githubOrigin: "https://github.test",
                  }),
                  TEST_GITHUB_APP_PUBLIC_KEY: WORKERS_GITHUB_APP_KEY.publicKey,
                },
              },
            };
          }),
        ],
        test: {
          name: "workers",
          include: ["__workers-tests__/**/*.test.ts", "../agents/__workers-tests__/**/*.test.ts"],
          // ONE RUNTIME FOR CONSECUTIVE FILES. Isolated, each file starts its own Miniflare and
          // fetches and compiles the worker's bundle into it: 2.8 s a file before its first test,
          // against 0.9 s shared (twelve files one after another, measured locally 2026-09-27). A
          // runner that ends a file keeps its runtime while the next queued file is a workers one
          // (vitest's pool).
          // fresh-file.ts, first, starts each file as a runtime of its own would: storage empty,
          // modules unevaluated, a new deploy.
          isolate: false,
          setupFiles: [
            "./__workers-tests__/fresh-file.ts",
            "./__workers-tests__/apply-migrations.ts",
          ],
          restoreMocks: true,
          unstubGlobals: true,
          unstubEnvs: true,
          chaiConfig: { truncateThreshold: 0 },
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
          chaiConfig: { truncateThreshold: 0 },
          // Boots the one shared worker and provides its URL (support/setup.ts injects it per file).
          globalSetup: ["./e2e/support/global-setup.ts"],
          setupFiles: ["./e2e/support/setup.ts"],
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
          chaiConfig: { truncateThreshold: 0 },
          globalSetup: ["./e2e/support/global-setup.ts"],
          // perf/setup.ts: what a failed row leaves for the latency guard beside its message
          setupFiles: ["./e2e/support/setup.ts", "./perf/setup.ts"],
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
