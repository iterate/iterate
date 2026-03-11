import { readFile } from "node:fs/promises";
import { inject, test as baseTest } from "vitest";
import { createDeploymentSlug } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import {
  type UseDeploymentFixture,
  useDeployment as createUseDeployment,
} from "@iterate-com/shared/jonasland";
import type {
  Deployment,
  DeploymentExecResult,
} from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import {
  appendVitestResultFooter,
  E2E_VITEST_RUN_ROOT_KEY,
  ensureVitestArtifactPaths,
  writeVitestResult,
} from "./vitest-artifacts.ts";

export interface E2EAttachedDeploymentFixture extends UseDeploymentFixture {
  artifacts: {
    dir: string;
    consoleLogPath: string;
    resultPath: string;
    eventsPath?: string;
  };
  snapshot(): ReturnType<Deployment["snapshot"]>;
  waitForShellSuccess(params: {
    cmd: string;
    timeoutMs: number;
    deployment?: Deployment;
  }): Promise<DeploymentExecResult>;
  waitForArtifactText(params: { needle: string; timeoutMs: number }): Promise<void>;
}

export interface E2EFixtures {
  e2e: {
    runRoot: string;
    outputDir: string;
    outputLogPath: string;
    resultPath: string;
    deploymentSlug: string;
    useDeployment(params: {
      deployment: Deployment;
      logTail?: number;
      destroyOnDispose?: boolean;
    }): Promise<E2EAttachedDeploymentFixture>;
    fileSlug: string;
    testSlug: string;
    fullName: string;
    testId: string;
  };
}

// Docs: https://vitest.dev/guide/test-context.html#test-extend
// Docs: https://vitest.dev/api/hooks#ontestfinished
// Design: tests that need artifacts should explicitly opt into this local base
// `test`. It creates one directory per test, keeps event logs next to
// `vitest-output.log`, records the final result in `result.json`, and exposes the
// whole artifact namespace as a single `{ e2e }` fixture.
export const test = baseTest.extend<E2EFixtures>({
  e2e: [
    async ({ task, onTestFailed, onTestFinished }, use) => {
      const runRoot = inject(E2E_VITEST_RUN_ROOT_KEY);
      const paths = await ensureVitestArtifactPaths({
        runRoot,
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
                : error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error);
          failureMessages.push(message);
        }
      });

      onTestFinished(async ({ task: finishedTask }) => {
        const result = finishedTask.result;
        const errorMessages =
          failureMessages.length > 0
            ? failureMessages
            : (result?.errors ?? []).map((error) =>
                typeof error?.stack === "string"
                  ? error.stack
                  : typeof error?.message === "string"
                    ? error.message
                    : error instanceof Error
                      ? (error.stack ?? error.message)
                      : String(error),
              );
        // Vitest dispatches `onConsoleLog` separately from this per-test finish
        // hook, so give the console tee a brief chance to flush before writing the
        // terminal result footer that should appear at the end of the log.
        await new Promise((resolve) => setTimeout(resolve, 25));
        await appendVitestResultFooter({
          outputLogPath: paths.outputLogPath,
          state: result?.state ?? "unknown",
          errorMessages,
        });
        await writeVitestResult({
          artifactDir: paths.artifactDir,
          resultPath: paths.resultPath,
          taskName: finishedTask.name,
          taskFullName: finishedTask.fullName,
          taskId: finishedTask.id,
          state: result?.state ?? "unknown",
          errors: errorMessages.map((message) => ({ message })),
        });
      });

      await use({
        runRoot,
        outputDir: paths.artifactDir,
        outputLogPath: paths.outputLogPath,
        resultPath: paths.resultPath,
        deploymentSlug: createDeploymentSlug({
          input: paths.testDirName,
          includeDate: true,
          includeTime: true,
        }),
        async useDeployment(params) {
          const attached = await createUseDeployment({
            deployment: params.deployment,
            logTail: params.logTail,
            destroyOnDispose: params.destroyOnDispose,
            artifactDir: paths.artifactDir,
          });
          return Object.assign(attached, {
            artifacts: {
              dir: paths.artifactDir,
              consoleLogPath: paths.outputLogPath,
              resultPath: paths.resultPath,
              eventsPath: attached.artifactPath,
            },
            snapshot() {
              return params.deployment.snapshot();
            },
            async waitForArtifactText(waitParams: { needle: string; timeoutMs: number }) {
              const eventsPath = attached.artifactPath;
              if (!eventsPath) {
                throw new Error("useDeployment fixture has no artifact path");
              }

              const deadline = Date.now() + waitParams.timeoutMs;
              let lastBody = "";

              while (Date.now() < deadline) {
                try {
                  lastBody = await readFile(eventsPath, "utf8");
                  if (lastBody.includes(waitParams.needle)) return;
                } catch {}
                await new Promise((resolve) => setTimeout(resolve, 200));
              }

              throw new Error(
                `Timed out waiting for artifact ${eventsPath} to contain ${JSON.stringify(waitParams.needle)}${
                  lastBody ? `; last body: ${lastBody}` : ""
                }`,
              );
            },
          });
        },
        fileSlug: paths.fileDirName,
        testSlug: paths.testDirName,
        fullName: task.fullName,
        testId: task.id,
      });
    },
    { auto: true },
  ],
});
