import { defineConfig } from "vitest/config";
import {
  appendVitestConsoleLineSync,
  createVitestRunRoot,
  E2E_VITEST_RUN_ROOT_KEY,
} from "./test-support/vitest-artifacts.ts";

const vitestRunRoot = createVitestRunRoot();

console.log(`[vitest-artifacts] run root: ${vitestRunRoot}`);

// Keep this file aligned with README.md.
// The README is the source of truth for tag vocabulary, case parameterisation,
// and the rule that provider selection happens via tags, not env-driven filtering.
export default defineConfig({
  test: {
    // Docs: https://vitest.dev/config/provide
    // Docs: https://vitest.dev/config/onconsolelog
    // Design: config owns the once-per-run root and provides it to workers.
    // `onConsoleLog(...)` stays here because Vitest exposes per-entity console
    // interception at config level, while the local `test.extend(...)` fixture
    // handles per-test result metadata next to the same `vitest-output.log`.
    environment: "node",
    provide: {
      [E2E_VITEST_RUN_ROOT_KEY]: vitestRunRoot,
    },
    tags: [
      {
        name: "providers/docker",
        description: "Tests that are specifically part of the Docker provider slice.",
      },
      {
        name: "providers/fly",
        description: "Tests that are specifically part of the Fly provider slice.",
      },
      {
        name: "slow",
        description: "Tests that are meaningfully slower than the normal inner loop.",
        timeout: 180_000,
      },
      {
        name: "no-internet",
        description: "Tests that should work without internet access.",
      },
      {
        name: "third-party-dependency",
        description:
          "Tests that depend on a third party outside our control, excluding the machine provider itself.",
      },
    ],
    include: [
      "vitest/**/*.e2e.ts",
      "vitest/**/*.e2e.test.ts",
      "vitest/**/*.test.ts",
      "tests/**/*.e2e.ts",
      "tests/**/*.e2e.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: ["tests/old/**"],
    // These tests exercise real runtimes. Keep concurrency intentionally low, and
    // require each case to be safe under parallel execution with unique slugs.
    maxWorkers: 2,
    maxConcurrency: 2,
    testTimeout: 120_000,
    onConsoleLog(log, type, entity) {
      if (entity?.type !== "test") return;

      appendVitestConsoleLineSync({
        runRoot: vitestRunRoot,
        moduleId: entity.module.moduleId,
        testFullName: entity.fullName,
        testId: entity.id,
        log,
        type,
      });
    },
  },
});
