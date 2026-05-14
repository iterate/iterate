import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestProject } from "../test-support/create-test-project.ts";
import { requireBaseUrl } from "../test-support/os2-client.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(thisDir, "../..");
const tuiTestBin = join(appRoot, "node_modules/.bin/tui-test");

const baseUrl = requireBaseUrl();
const project = await createTestProject({
  baseUrl,
  slugPrefix: "tui-test",
});

try {
  console.info(`[tui-test] Created disposable project ${project.project.id}`);
  await runTuiTest({
    env: {
      ...process.env,
      OS2_BASE_URL: baseUrl,
      OS2_TUI_TEST_PROJECT_SLUG_OR_ID: project.project.id,
    },
  });
} finally {
  await project[Symbol.asyncDispose]();
  console.info(`[tui-test] Deleted disposable project ${project.project.id}`);
}

async function runTuiTest(input: { env: NodeJS.ProcessEnv }) {
  const child = spawn(tuiTestBin, process.argv.slice(2), {
    cwd: thisDir,
    env: input.env,
    stdio: "inherit",
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });

  if (exitCode !== 0) {
    throw new Error(`tui-test exited with code ${exitCode ?? "unknown"}.`);
  }
}
