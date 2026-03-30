import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createSlug } from "@iterate-com/shared/jonasland";

export const E2E_VITEST_RUN_ROOT_KEY = "e2eVitestRunRoot";

const E2E_VITEST_PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface VitestArtifactPathParams {
  runRoot: string;
  moduleId: string;
  testFullName: string;
  testId?: string;
}

export interface VitestArtifactPaths {
  fileDirName: string;
  testDirName: string;
  artifactDir: string;
  outputLogPath: string;
  resultPath: string;
}

export function createVitestRunRoot() {
  return mkdtempSync(join(tmpdir(), "e2e-vitest-"));
}

export async function ensureVitestArtifactPaths(params: VitestArtifactPathParams) {
  const paths = resolveVitestArtifactPaths(params);
  await mkdir(paths.artifactDir, { recursive: true });
  await writeFile(paths.outputLogPath, "", { flag: "a" });
  return paths;
}

export function appendVitestConsoleLineSync(
  params: VitestArtifactPathParams & {
    log: string;
    type: "stdout" | "stderr";
  },
) {
  const paths = resolveVitestArtifactPaths(params);
  mkdirSync(paths.artifactDir, { recursive: true });
  appendFileSync(paths.outputLogPath, formatConsoleLine(params));
}

export function resolveVitestArtifactPaths(params: VitestArtifactPathParams): VitestArtifactPaths {
  const relativeModulePath = relative(E2E_VITEST_PROJECT_ROOT, params.moduleId).replaceAll(
    "\\",
    "/",
  );
  const fileDirName = createSlug({
    input: relativeModulePath,
  });
  const normalizedFullName = stripFilePrefix({
    relativeModulePath,
    testFullName: params.testFullName,
  });
  const testIdSuffix = params.testId
    ? `-${createSlug({ input: params.testId, maxLength: 12 })}`
    : "";
  const testDirName = `${createSlug({ input: normalizedFullName, maxLength: 96 })}${testIdSuffix}`;
  const artifactDir = join(params.runRoot, fileDirName, testDirName);
  return {
    fileDirName,
    testDirName,
    artifactDir,
    outputLogPath: join(artifactDir, "vitest-output.log"),
    resultPath: join(artifactDir, "result.json"),
  };
}

export async function writeVitestResult(params: {
  artifactDir: string;
  resultPath: string;
  taskName: string;
  taskFullName: string;
  taskId: string;
  state: string;
  errors?: ReadonlyArray<{ message?: string }>;
}) {
  await mkdir(params.artifactDir, { recursive: true });
  await writeFile(
    params.resultPath,
    `${JSON.stringify(
      {
        name: params.taskName,
        fullName: params.taskFullName,
        id: params.taskId,
        state: normalizeResultState(params.state),
        errorMessages: params.errors?.map((error) => error.message).filter(Boolean) ?? [],
        writtenAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

export async function appendVitestResultFooter(params: {
  outputLogPath: string;
  state: string;
  errorMessages: readonly string[];
}) {
  const normalizedState = normalizeResultState(params.state);
  const footerLines = ["", "===== VITEST RESULT =====", `state: ${normalizedState}`];

  if (params.errorMessages.length > 0) {
    footerLines.push("errors:");
    for (const message of params.errorMessages) {
      footerLines.push(indentBlock(message, "  - "));
    }
  }

  footerLines.push("=========================");
  footerLines.push("");

  await appendFile(params.outputLogPath, `${footerLines.join("\n")}`);
}

function formatConsoleLine(params: { log: string; type: "stdout" | "stderr" }) {
  const content = params.log.endsWith("\n") ? params.log : `${params.log}\n`;
  return `${new Date().toISOString()} [${params.type}] ${content}`;
}

function stripFilePrefix(params: { relativeModulePath: string; testFullName: string }) {
  const prefix = `${params.relativeModulePath} > `;
  if (params.testFullName.startsWith(prefix)) {
    return params.testFullName.slice(prefix.length);
  }
  return params.testFullName;
}

function normalizeResultState(state: string) {
  if (state === "pass") return "passed";
  if (state === "fail") return "failed";
  return state;
}

function indentBlock(value: string, prefix: string) {
  const [firstLine, ...rest] = value.split("\n");
  return [prefix + firstLine, ...rest.map((line) => `    ${line}`)].join("\n");
}
