import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  appendConsoleLineSync,
  createVitestRunRoot,
  E2E_PROJECT_ROOT_KEY,
  E2E_RUN_ROOT_KEY,
} from "@iterate-com/shared/test-support/vitest-e2e";
import { E2E_REPO_ROOT_KEY, E2E_RUN_SLUG_KEY } from "./test-support/provide-keys.ts";
import { createVitestRunSlug } from "./test-support/vitest-naming.ts";

const e2eRoot = fileURLToPath(new URL(".", import.meta.url));
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const vitestRunSlug = createVitestRunSlug();
const vitestRunRoot = createVitestRunRoot("os-e2e-");

console.log(`[vitest-artifacts] run root: ${vitestRunRoot}`);
console.log(`[vitest] run slug: ${vitestRunSlug}`);

export default defineConfig({
  resolve: {
    alias: {
      "~": resolve(appRoot, "src"),
    },
  },
  test: {
    environment: "node",
    // Parallel in CI: each file creates its own projects against a deployed
    // slot, so files are independent. Sequential locally to not hammer a
    // single dev server.
    fileParallelism: process.env.CI === "true",
    // Cap the stampede: 9 files all first-touching a freshly deployed slot
    // at once is what pushes cold creates past the (deliberately tight)
    // saga timeout. See tasks/os-cold-create-latency.md.
    maxWorkers: 4,
    // Generous: e2e runs against live deployments, concurrently with the
    // Playwright specs in preview CI — cold slots under combined load need
    // headroom, and slow-but-passing beats flaky.
    hookTimeout: 240_000,
    include: ["./e2e/vitest/**/*.test.ts"],
    passWithNoTests: true,
    setupFiles: ["./e2e/vitest/setup.ts"],
    provide: {
      [E2E_RUN_ROOT_KEY]: vitestRunRoot,
      [E2E_PROJECT_ROOT_KEY]: e2eRoot,
      [E2E_RUN_SLUG_KEY]: vitestRunSlug,
      [E2E_REPO_ROOT_KEY]: repoRoot,
    },
    testTimeout: 240_000,
    onConsoleLog(log, type, entity) {
      if (entity?.type !== "test") return;

      appendConsoleLineSync({
        runRoot: vitestRunRoot,
        projectRoot: e2eRoot,
        moduleId: entity.module.moduleId,
        testFullName: entity.fullName,
        testId: entity.id,
        log,
        type,
      });
    },
  },
});
