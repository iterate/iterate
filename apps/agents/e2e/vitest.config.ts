import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  appendConsoleLineSync,
  createVitestRunRoot,
  E2E_PROJECT_ROOT_KEY,
  E2E_RUN_ROOT_KEY,
} from "@iterate-com/shared/test-support/vitest-e2e";
import {
  E2E_EVENTS_BASE_URL_KEY,
  E2E_REPO_ROOT_KEY,
  E2E_RUN_SLUG_KEY,
} from "./test-support/provide-keys.ts";
import { createVitestRunSlug } from "./test-support/vitest-naming.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const e2eRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const vitestRunSlug = createVitestRunSlug();
const vitestRunRoot = createVitestRunRoot("agents-e2e-");

const eventsBaseUrl =
  process.env.EVENTS_BASE_URL?.trim().replace(/\/+$/, "") || "https://events.iterate.com";

console.log(`[vitest-artifacts] run root: ${vitestRunRoot}`);
console.log(`[vitest] run slug: ${vitestRunSlug}`);
console.log(`[vitest] events base url: ${eventsBaseUrl}`);

export default defineConfig({
  resolve: {
    alias: {
      "~": resolve(appRoot, "src"),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["./e2e/vitest/**/*.test.ts"],
    provide: {
      [E2E_RUN_ROOT_KEY]: vitestRunRoot,
      [E2E_PROJECT_ROOT_KEY]: e2eRoot,
      [E2E_EVENTS_BASE_URL_KEY]: eventsBaseUrl,
      [E2E_RUN_SLUG_KEY]: vitestRunSlug,
      [E2E_REPO_ROOT_KEY]: repoRoot,
    },
    tags: [
      {
        name: "local-dev-server",
        description: "Spins up a local agents dev server for the test",
      },
      {
        name: "deployed-ephemeral-worker-with-egress-capture",
        description: "Deploys a temporary CF worker with controlled egress",
      },
      {
        name: "deployed-live-worker",
        description: "Runs against an existing shared deployment (staging/prod)",
      },
      {
        name: "mocked-internet",
        description: "Uses HAR replay / mock proxy, no real upstream calls",
      },
      {
        name: "live-internet",
        description: "Hits real external services (LLMs, MCP servers, etc.)",
      },
      {
        name: "slow",
        description: "Materially slower than inner loop (real LLM calls, even if cached)",
        timeout: 240_000,
      },
    ],
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
