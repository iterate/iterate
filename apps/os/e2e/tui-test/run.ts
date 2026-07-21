import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTuiRetryTelemetry } from "@iterate-com/shared/test-support/e2e-policy";
import { createTestProject } from "../test-support/create-test-project.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(thisDir, "../..");
const repositoryRoot = join(appRoot, "../..");
const tuiTestBin = join(appRoot, "node_modules/.bin/tui-test");

console.info("[tui-test] Building the published iterate CLI and OpenTUI entrypoint");
await runProcess("pnpm", ["--dir", join(repositoryRoot, "packages/iterate"), "build"], {
  cwd: repositoryRoot,
  env: process.env,
  captureOutput: false,
});

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
      FORCE_COLOR: "0",
      // The workspace bin normally delegates to TypeScript source for local
      // development. This lane exists to prove the artifact users install.
      ITERATE_FORCE_BUILT_PACKAGE: "1",
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
  const result = await runProcess(tuiTestBin, process.argv.slice(2), {
    cwd: thisDir,
    env: input.env,
    captureOutput: true,
  });

  const telemetry = parseTuiRetryTelemetry(result.stdout);
  const telemetryFile = input.env.E2E_RETRY_TELEMETRY_FILE;
  if (telemetryFile != null && telemetryFile !== "") {
    writeFileSync(telemetryFile, `${JSON.stringify(telemetry, null, 2)}\n`);
  }
  if (telemetry.retried.length > 0) {
    console.info(
      `[retry-telemetry] ${telemetry.retried.length} TUI test(s) needed retries: ${telemetry.retried
        .map((record) => `${record.fullName} (x${record.retryCount})`)
        .join(", ")}`,
    );
  }

  if (result.exitCode !== 0) {
    await dumpChatPtyTranscript(input.env);
    throw new Error(`tui-test exited with code ${result.exitCode ?? "unknown"}.`);
  }
}

/**
 * A tui-test timeout reports nothing about WHAT the terminal showed — in CI
 * that is the difference between "the agent was slow" and "the CLI crashed at
 * import". On failure, re-run the exact chat command under a real PTY
 * (util-linux `script` on the runners; BSD `script` locally) for a bounded
 * window and print the raw transcript, crash output included.
 */
async function dumpChatPtyTranscript(env: NodeJS.ProcessEnv) {
  const iterateBin = join(repositoryRoot, "packages/iterate/bin/iterate.js");
  const chat = `${process.execPath} ${iterateBin} chat --project ${env.OS_E2E_TUI_PROJECT_ID} --agent-path /agents/tui-diagnostic`;
  const command =
    process.platform === "linux"
      ? ["script", ["-qec", `timeout 20 ${chat}`, "/dev/null"]]
      : (["script", ["-q", "/dev/null", "sh", "-c", `${chat} & sleep 20; kill %1`]] as const);
  console.info(`[tui-test] diagnostic PTY transcript of: ${chat}`);
  try {
    await runProcess(command[0] as string, command[1] as string[], {
      cwd: thisDir,
      env,
      captureOutput: false,
    });
  } catch (error) {
    // The timeout kill is the expected exit; a spawn failure is itself signal.
    console.info(`[tui-test] diagnostic PTY run ended: ${String(error)}`);
  }
}

async function runProcess(
  command: string,
  args: string[],
  input: { cwd: string; env: NodeJS.ProcessEnv; captureOutput: boolean },
): Promise<{ exitCode: number | null; stdout: string }> {
  const child = spawn(command, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: input.captureOutput ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  let stdout = "";
  if (child.stdout != null) {
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
  }
  if (child.stderr != null) {
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  }

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  if (!input.captureOutput && exitCode !== 0) {
    throw new Error(`${command} exited with code ${exitCode ?? "unknown"}.`);
  }
  return { exitCode, stdout };
}
