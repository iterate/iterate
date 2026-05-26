import { randomBytes } from "node:crypto";
import { relative } from "node:path";
import { inject, type TestContext } from "vitest";
import { slugify } from "@iterate-com/shared/slugify";
import type { StreamPath } from "@iterate-com/shared/streams/types";
import {
  appendResultFooter,
  ensureArtifactPaths,
  E2E_PROJECT_ROOT_KEY,
  E2E_RUN_ROOT_KEY,
  writeResult,
} from "@iterate-com/shared/test-support/vitest-e2e";
import { E2E_REPO_ROOT_KEY, E2E_RUN_SLUG_KEY } from "./provide-keys.ts";
import { formatDateTime } from "./vitest-naming.ts";

export interface E2EContext {
  artifactDir: string;
  createStreamPath(opts?: { suffix?: string }): StreamPath;
  executionSuffix: string;
  repoRoot: string;
  runSlug: string;
}

export async function setupE2E(ctx: TestContext): Promise<E2EContext> {
  const { task, onTestFailed, onTestFinished } = ctx;
  const runRoot = inject(E2E_RUN_ROOT_KEY as never) as string;
  const projectRoot = inject(E2E_PROJECT_ROOT_KEY as never) as string;
  const runSlug = inject(E2E_RUN_SLUG_KEY as never) as string;
  const repoRoot = inject(E2E_REPO_ROOT_KEY as never) as string;
  const executionSuffix = createTestExecutionSuffix();

  const paths = await ensureArtifactPaths({
    runRoot,
    projectRoot,
    moduleId: task.file.filepath,
    testFullName: task.fullName,
    testId: task.id,
  });

  const failureMessages: string[] = [];

  onTestFailed(({ task: failedTask }) => {
    for (const error of failedTask.result?.errors ?? []) {
      failureMessages.push(errorToMessage(error));
    }
  });

  onTestFinished(async ({ task: finishedTask }) => {
    const result = finishedTask.result;
    const errorMessages = [
      ...failureMessages,
      ...(result?.errors ?? []).map((error) => errorToMessage(error)),
    ];
    await new Promise((resolve) => setTimeout(resolve, 25));
    await appendResultFooter({
      outputLogPath: paths.outputLogPath,
      state: result?.state ?? "unknown",
      errorMessages,
    });
    await writeResult({
      artifactDir: paths.artifactDir,
      resultPath: paths.resultPath,
      taskName: finishedTask.name,
      taskFullName: finishedTask.fullName,
      taskId: finishedTask.id,
      state: result?.state ?? "unknown",
      errors: errorMessages.map((message) => ({ message })),
    });
  });

  function createStreamPath(opts?: { suffix?: string }): StreamPath {
    const relativeFilePath = relative(repoRoot, task.file.filepath).replaceAll("\\", "/");
    const strippedFullName = stripFilePrefix({ relativeFilePath, testFullName: task.fullName });
    const hierarchy = strippedFullName.split(" > ").filter(Boolean);
    const fileSegments = relativeFilePath
      .split("/")
      .filter(Boolean)
      .map((segment) => slugify(segment));
    const hierarchySegments = hierarchy.map((segment) => slugify(segment));
    const suffix = opts?.suffix ? `-${opts.suffix}` : "";
    const executionSegment = slugify(`${executionSuffix}${suffix}`);
    return `/${[...fileSegments, ...hierarchySegments, executionSegment].join("/")}` as StreamPath;
  }

  return {
    artifactDir: paths.artifactDir,
    createStreamPath,
    executionSuffix,
    repoRoot,
    runSlug,
  };
}

function createTestExecutionSuffix(now: Date = new Date()) {
  return `${formatDateTime(now)}-${randomBytes(3).toString("hex")}`;
}

function stripFilePrefix(args: { relativeFilePath: string; testFullName: string }) {
  const prefix = `${args.relativeFilePath} > `;
  if (args.testFullName.startsWith(prefix)) {
    return args.testFullName.slice(prefix.length);
  }
  return args.testFullName;
}

function errorToMessage(error: unknown) {
  return error != null &&
    typeof error === "object" &&
    "stack" in error &&
    typeof error.stack === "string"
    ? error.stack
    : error != null &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string"
      ? error.message
      : String(error);
}
