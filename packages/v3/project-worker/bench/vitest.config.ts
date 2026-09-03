// bench/vitest.config.ts — the BENCH lane (`pnpm bench`): vitest's benchmark runner (tinybench) over
// the same client the e2e lane uses, against the same one worker — local workerd by default, the
// DEPLOYED worker with `WORKER_BASE_URL=https://project-worker.iterate.workers.dev` (the numbers
// that count; see docs/perf/). Files run one at a time so scenarios never share the wire.
// `BENCH_OUT=<file.json>` writes tinybench's raw samples for the log.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bench",
    environment: "node",
    include: [],
    benchmark: {
      include: ["bench/**/*.bench.ts"],
      ...(process.env.BENCH_OUT && { outputJson: process.env.BENCH_OUT }),
    },
    globalSetup: ["./e2e/support/global-setup.ts"],
    setupFiles: ["./e2e/support/setup.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
