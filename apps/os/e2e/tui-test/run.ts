import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestProject } from "../test-support/create-test-project.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(thisDir, "../..");
const tuiTestBin = join(appRoot, "node_modules/.bin/tui-test");

const project = await createTestProject({
  slugPrefix: "tui-test",
});

// `iterate chat` reads the OS base URL from the iterate config file, so point
// XDG_CONFIG_HOME at a throwaway config naming the disposable project's URL.
const xdgConfigHome = mkdtempSync(join(tmpdir(), "iterate-tui-test-xdg-"));
mkdirSync(join(xdgConfigHome, "iterate"), { recursive: true });
writeFileSync(
  join(xdgConfigHome, "iterate", "config.json"),
  `${JSON.stringify(
    {
      configs: { "tui-test": { osBaseUrl: project.baseUrl } },
      default: "tui-test",
    },
    null,
    2,
  )}\n`,
);

try {
  console.info(`[tui-test] Created disposable project ${project.project.id}`);
  await runTuiTest({
    env: {
      ...process.env,
      APP_CONFIG_BASE_URL: project.baseUrl,
      OS_E2E_TUI_PROJECT_ID: project.project.id,
      XDG_CONFIG_HOME: xdgConfigHome,
    },
  });
} finally {
  rmSync(xdgConfigHome, { recursive: true, force: true });
  // Disposal is currently a no-op: the itx surface has no projects.remove yet
  // (tasks/os-project-archival.md), so disposable TUI projects are leaked until stages reset.
  await project[Symbol.asyncDispose]();
  console.info(
    `[tui-test] Released disposable project ${project.project.id} (removal pending tasks/os-project-archival.md)`,
  );
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
