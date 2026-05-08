import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { slugify } from "../../slugify.ts";

export const E2E_RUN_ROOT_KEY = "e2eRunRoot";
export const E2E_PROJECT_ROOT_KEY = "e2eProjectRoot";

export interface ArtifactPathParams {
  runRoot: string;
  projectRoot: string;
  moduleId: string;
  testFullName: string;
  testId?: string;
}

export interface ArtifactPaths {
  fileSlug: string;
  testSlug: string;
  artifactDir: string;
  outputLogPath: string;
  resultPath: string;
}

export function createVitestRunRoot(prefix?: string) {
  return mkdtempSync(join(tmpdir(), prefix ?? "e2e-vitest-"));
}

export function resolveArtifactPaths(params: ArtifactPathParams): ArtifactPaths {
  const relativeModulePath = relative(params.projectRoot, params.moduleId).replaceAll("\\", "/");
  const fileSlug = slugify(relativeModulePath);
  const normalizedFullName = stripFilePrefix({
    relativeModulePath,
    testFullName: params.testFullName,
  });
  const testIdSuffix = params.testId ? `-${slugify(params.testId, { maxLength: 12 })}` : "";
  const testSlug = `${slugify(normalizedFullName, { maxLength: 96 })}${testIdSuffix}`;
  const artifactDir = join(params.runRoot, fileSlug, testSlug);
  return {
    fileSlug,
    testSlug,
    artifactDir,
    outputLogPath: join(artifactDir, "vitest-output.log"),
    resultPath: join(artifactDir, "result.json"),
  };
}

export async function ensureArtifactPaths(params: ArtifactPathParams) {
  const paths = resolveArtifactPaths(params);
  await mkdir(paths.artifactDir, { recursive: true });
  await writeFile(paths.outputLogPath, "", { flag: "a" });
  return paths;
}

export function appendConsoleLineSync(
  params: ArtifactPathParams & {
    log: string;
    type: "stdout" | "stderr";
  },
) {
  const paths = resolveArtifactPaths(params);
  mkdirSync(paths.artifactDir, { recursive: true });
  appendFileSync(paths.outputLogPath, formatConsoleLine(params));
}

export async function writeResult(params: {
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

export async function appendResultFooter(params: {
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
