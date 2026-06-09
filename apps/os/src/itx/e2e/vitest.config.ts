import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  appendConsoleLineSync,
  createVitestRunRoot,
  E2E_PROJECT_ROOT_KEY,
  E2E_RUN_ROOT_KEY,
} from "@iterate-com/shared/test-support/vitest-e2e";
import { E2E_REPO_ROOT_KEY, E2E_RUN_SLUG_KEY } from "../../../e2e/test-support/provide-keys.ts";
import { createVitestRunSlug } from "../../../e2e/test-support/vitest-naming.ts";

const e2eRoot = fileURLToPath(new URL("../../../e2e", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const vitestRunSlug = process.env.OS_E2E_RUN_SLUG?.trim() || createVitestRunSlug();
const vitestRunRoot = createVitestRunRoot("os-itx-e2e-");

console.log(`[vitest-artifacts] run root: ${vitestRunRoot}`);
console.log(`[vitest] run slug: ${vitestRunSlug}`);

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["./src/itx/e2e/*.e2e.test.ts"],
    passWithNoTests: true,
    provide: {
      [E2E_PROJECT_ROOT_KEY]: e2eRoot,
      [E2E_REPO_ROOT_KEY]: repoRoot,
      [E2E_RUN_ROOT_KEY]: vitestRunRoot,
      [E2E_RUN_SLUG_KEY]: vitestRunSlug,
    },
    testTimeout: 120_000,
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
