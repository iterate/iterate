import { randomBytes } from "node:crypto";
import { relative } from "node:path";
import type { StreamPath } from "@iterate-com/events-contract";
import { slugify } from "@iterate-com/shared/slugify";
import {
  appendResultFooter,
  ensureArtifactPaths,
  writeResult,
} from "@iterate-com/shared/test-support/vitest-e2e";
import { inject } from "vitest";
import type { TestContext } from "vitest";
import { createEventsHelpers, type EventsHelpers } from "./events-stream.ts";
import { E2E_EVENTS_BASE_URL_KEY, E2E_REPO_ROOT_KEY, E2E_RUN_SLUG_KEY } from "./provide-keys.ts";

export { E2E_EVENTS_BASE_URL_KEY, E2E_REPO_ROOT_KEY, E2E_RUN_SLUG_KEY } from "./provide-keys.ts";

export interface E2EContext {
  executionSuffix: string;
  runSlug: string;
  eventsBaseUrl: string;
  repoRoot: string;
  events: EventsHelpers;
  artifactDir: string;
  createStreamPath(opts?: { suffix?: string }): StreamPath;
}

export async function setupE2E(ctx: TestContext): Promise<E2EContext> {
  const { task, onTestFailed, onTestFinished } = ctx;
  const runRoot = inject("e2eRunRoot" as never) as string;
  const projectRoot = inject("e2eProjectRoot" as never) as string;
  const eventsBaseUrl = inject(E2E_EVENTS_BASE_URL_KEY as never) as string;
  const runSlug = inject(E2E_RUN_SLUG_KEY as never) as string;
  const repoRoot = inject(E2E_REPO_ROOT_KEY as never) as string;
  const executionSuffix = createTestExecutionSuffix();
  const events = createEventsHelpers({ baseUrl: eventsBaseUrl, projectSlug: runSlug });

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
      const message =
        typeof error?.stack === "string"
          ? error.stack
          : typeof error?.message === "string"
            ? error.message
            : String(error);
      failureMessages.push(message);
    }
  });

  onTestFinished(async ({ task: finishedTask }) => {
    const result = finishedTask.result;
    const errorMessages =
      failureMessages.length > 0
        ? failureMessages
        : (result?.errors ?? []).map((e) =>
            typeof e?.stack === "string"
              ? e.stack
              : typeof e?.message === "string"
                ? e.message
                : String(e),
          );
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

  const defaultStreamPath = createStreamPath();
  const viewerUrl = events.streamViewerUrl(defaultStreamPath);
  console.info(`[e2e] Events stream: ${viewerUrl}`);

  return {
    executionSuffix,
    runSlug,
    eventsBaseUrl,
    repoRoot,
    events,
    artifactDir: paths.artifactDir,
    createStreamPath,
  };
}

function createTestExecutionSuffix(now: Date = new Date()) {
  return `${formatDateTime(now)}-${randomBytes(3).toString("hex")}`;
}

function formatDateTime(date: Date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function stripFilePrefix(args: { relativeFilePath: string; testFullName: string }) {
  const prefix = `${args.relativeFilePath} > `;
  if (args.testFullName.startsWith(prefix)) {
    return args.testFullName.slice(prefix.length);
  }
  return args.testFullName;
}
