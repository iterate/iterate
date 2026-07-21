import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compactRetryFailure,
  E2E_CI_RETRIES,
  E2E_CI_RETRY_DELAY_MS,
  runTuiCaseWithRetry,
  type TuiCaseResult,
} from "@iterate-com/shared/test-support/e2e-policy";
import { createTestProject } from "../test-support/create-test-project.ts";

type TuiCase = {
  id: string;
  fullName: string;
  specFile: string;
};

type ProcessResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

const thisDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(thisDir, "../..");
const repositoryRoot = join(appRoot, "../..");
const tuiTestBin = join(appRoot, "node_modules/.bin/tui-test");
const traceRoot = join(thisDir, "tui-traces");

const cases: TuiCase[] = [
  {
    id: "agent-chat",
    fullName: "Agent chat TUI connects, renders the feed, and sends",
    specFile: "agent-chat.spec.ts",
  },
  {
    id: "computer-provider",
    fullName: "starts the existing computer provider from /use-my-computer",
    specFile: "computer-provider.spec.ts",
  },
];
if (process.env.OS_E2E_TUI_SNAPSHOT === "1") {
  cases.push({
    id: "manual-snapshot",
    fullName: "captures a manual aesthetic snapshot",
    specFile: "manual-snapshot.spec.ts",
  });
}

console.info("[tui-test] Building the published iterate CLI and OpenTUI entrypoint");
await runProcess("pnpm", ["--dir", join(repositoryRoot, "packages/iterate"), "build"], {
  cwd: repositoryRoot,
  env: process.env,
  captureOutput: false,
});

// Marathon runs reuse a checkout. Clear the complete tree so an unneeded retry
// from a previous run can never masquerade as evidence from this one.
rmSync(traceRoot, { recursive: true, force: true });
console.info(`[tui-test] Running ${cases.length} isolated workflow(s) concurrently`);
const results = await Promise.all(cases.map((testCase) => runTuiCase(testCase)));
const retried = results
  .filter((result) => result.attemptsUsed > 1)
  .map((result) => ({
    fullName: result.testCase.fullName,
    retryCount: result.attemptsUsed - 1,
    passedAfterRetry: result.passed,
    ...(result.firstFailure ? { firstFailure: result.firstFailure } : {}),
  }));

const telemetryFile = process.env.E2E_RETRY_TELEMETRY_FILE;
if (telemetryFile != null && telemetryFile !== "") {
  writeFileSync(telemetryFile, `${JSON.stringify({ retried }, null, 2)}\n`);
}
if (retried.length > 0) {
  console.info(
    `[retry-telemetry] ${retried.length} TUI test(s) needed retries: ${retried
      .map(
        (record) =>
          `${record.fullName} (x${record.retryCount}${record.passedAfterRetry ? "" : ", still failed"})${record.firstFailure ? ` — ${record.firstFailure}` : ""}`,
      )
      .join("; ")}`,
  );
}

const failed = results.filter((result) => !result.passed);
if (failed.length > 0) {
  throw new Error(
    `${failed.length} TUI workflow(s) failed: ${failed
      .map(
        (result) =>
          `${result.testCase.fullName}${result.finalFailure ? ` — ${result.finalFailure}` : ""}`,
      )
      .join("; ")}`,
  );
}

async function runTuiCase(testCase: TuiCase): Promise<TuiCaseResult & { testCase: TuiCase }> {
  const maxAttempts = process.env.CI ? E2E_CI_RETRIES + 1 : 1;
  const result = await runTuiCaseWithRetry({
    maxAttempts,
    retryDelayMs: E2E_CI_RETRY_DELAY_MS,
    runAttempt: async (attempt) => {
      try {
        const processResult = await runTuiAttempt({ attempt, maxAttempts, testCase });
        return {
          passed: processResult.exitCode === 0,
          ...(processResult.exitCode === 0
            ? {}
            : { failure: summarizeTuiFailure(processResult, testCase) }),
        };
      } catch (error) {
        const failure = compactRetryFailure(error) ?? "TUI attempt failed without an error message";
        console.error(`[tui-test:${testCase.id}] ${failure}`);
        return { passed: false, failure };
      }
    },
    onRetry: ({ attempt, failure }) => {
      console.warn(
        `[tui-test:${testCase.id}] attempt ${attempt} failed${failure ? `: ${failure}` : ""}; ` +
          `retrying in a fresh process and project after ${E2E_CI_RETRY_DELAY_MS}ms`,
      );
    },
  });

  return { ...result, testCase };
}

async function runTuiAttempt(input: {
  attempt: number;
  maxAttempts: number;
  testCase: TuiCase;
}): Promise<ProcessResult> {
  const { attempt, maxAttempts, testCase } = input;
  const traceFolder = join(traceRoot, testCase.id, `attempt-${attempt}`);

  const project = await createTestProject({
    slugPrefix: `tui-${testCase.id}`,
  });
  let testRoot: string | undefined;
  let xdgConfigHome: string | undefined;

  try {
    // TUI Test rewrites every discovered spec into a fixed `.tui-test/cache`
    // below cwd. Give concurrent cases independent project roots so their
    // transforms cannot clean or overwrite one another's cache.
    const caseRunsRoot = join(thisDir, ".tui-test", "case-runs");
    mkdirSync(caseRunsRoot, { recursive: true });
    testRoot = mkdtempSync(join(caseRunsRoot, `${testCase.id}-`));
    copyFileSync(join(thisDir, "tui-test.config.ts"), join(testRoot, "tui-test.config.ts"));
    copyFileSync(join(thisDir, testCase.specFile), join(testRoot, testCase.specFile));

    // `iterate chat` reads the OS base URL from the iterate config file. Each
    // workflow attempt gets an independent config and disposable project.
    xdgConfigHome = mkdtempSync(join(tmpdir(), `iterate-tui-${testCase.id}-xdg-`));
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

    console.info(
      `[tui-test:${testCase.id}] attempt ${attempt}/${maxAttempts} using ${project.project.id}`,
    );
    const result = await runProcess(tuiTestBin, [testCase.specFile, ...process.argv.slice(2)], {
      cwd: testRoot,
      env: {
        ...process.env,
        APP_CONFIG_BASE_URL: project.baseUrl,
        FORCE_COLOR: "0",
        // The workspace bin normally delegates to TypeScript source. This
        // lane exists to prove the artifact users install.
        ITERATE_FORCE_BUILT_PACKAGE: "1",
        OS_E2E_TUI_ITERATE_BIN: join(repositoryRoot, "packages/iterate/bin/iterate.js"),
        OS_E2E_TUI_PROJECT_ID: project.project.id,
        OS_E2E_TUI_TRACE_FOLDER: traceFolder,
        XDG_CONFIG_HOME: xdgConfigHome,
      },
      captureOutput: true,
    });
    console.info(
      `[tui-test:${testCase.id}] attempt ${attempt}/${maxAttempts} exited ${result.exitCode ?? "without a code"}`,
    );
    return result;
  } finally {
    if (testRoot) {
      rmSync(testRoot, { recursive: true, force: true });
    }
    if (xdgConfigHome) {
      rmSync(xdgConfigHome, { recursive: true, force: true });
    }
    // Disposal is currently a no-op: the itx surface has no projects.remove
    // yet, so test projects remain until the preview stage is reset.
    await project[Symbol.asyncDispose]();
    console.info(
      `[tui-test:${testCase.id}] released ${project.project.id} (removal pending tasks/os-project-archival.md)`,
    );
  }
}

function summarizeTuiFailure(result: ProcessResult, testCase: TuiCase): string {
  const output = `${result.stderr}\n${result.stdout}`.replaceAll(
    // eslint-disable-next-line no-control-regex -- strips ANSI from child diagnostics.
    /\u001B\[[0-?]*[ -/]*[@-~]/gu,
    "",
  );
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const interesting = lines.find((line) =>
    /(assertionerror|\berror\b|timed out|timeout|worker terminated|expected|received)/iu.test(line),
  );
  return (
    compactRetryFailure(interesting ?? lines.at(-1)) ??
    `${testCase.fullName} exited with code ${result.exitCode ?? "unknown"}`
  );
}

async function runProcess(
  command: string,
  args: string[],
  input: { cwd: string; env: NodeJS.ProcessEnv; captureOutput: boolean },
): Promise<ProcessResult> {
  const child = spawn(command, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: input.captureOutput ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  let stdout = "";
  let stderr = "";
  if (child.stdout != null) {
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
  }
  if (child.stderr != null) {
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
  }

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  if (!input.captureOutput && exitCode !== 0) {
    throw new Error(`${command} exited with code ${exitCode ?? "unknown"}.`);
  }
  return { exitCode, stderr, stdout };
}
