import { defineConfig } from "@microsoft/tui-test";
import { TUI_TEST_TIMEOUT_MS } from "@iterate-com/shared/test-support/e2e-policy";

const projectId = process.env.OS_E2E_TUI_PROJECT_ID?.trim();
if (!projectId) {
  throw new Error("OS_E2E_TUI_PROJECT_ID is required; run the specs through run.ts.");
}

const iterateBin = process.env.OS_E2E_TUI_ITERATE_BIN?.trim();
if (!iterateBin) {
  throw new Error("OS_E2E_TUI_ITERATE_BIN is required; run the specs through run.ts.");
}

export default defineConfig({
  testMatch: "*.spec.ts",
  // TUI Test 0.0.4 kills a timed-out worker and reuses that dead worker for
  // its built-in retry. run.ts owns the one permitted retry instead, using a
  // fresh process and project for the individual failed workflow.
  retries: 0,
  timeout: TUI_TEST_TIMEOUT_MS,
  trace: true,
  traceFolder: process.env.OS_E2E_TUI_TRACE_FOLDER || "tui-traces",
  workers: 1,
  use: {
    columns: 100,
    rows: 32,
    // run.ts builds the published CLI, gives this case a fresh project/config,
    // and invokes each spec in a dedicated process.
    program: {
      file: process.execPath,
      args: [iterateBin, "chat", "--project", projectId, "--agent-path", "/agents/tui-test"],
    },
  },
});
