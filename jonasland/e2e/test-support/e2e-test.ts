import { readFile } from "node:fs/promises";
import { inject, test as baseTest } from "vitest";
import { createDeploymentSlug } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import {
  type DeploymentLogsArtifact,
  type UseDeploymentFixture,
  useDeployment as createUseDeployment,
} from "@iterate-com/shared/jonasland";
import type { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { resolveIngressProxyConfig } from "../test-helpers/old/public-ingress-config.ts";
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
    logsPath?: string;
  };
  snapshot(): ReturnType<Deployment["snapshot"]>;
  waitForArtifactText(params: { needle: string; timeoutMs: number }): Promise<void>;
  useIngressProxyRoutes(params: {
    targetURL: string;
    publicBaseHost?: string;
    routingType?: "subdomain-host" | "dunder-prefix";
    ingressDefaultService?: string;
    metadata?: Record<string, unknown>;
    timeoutMs?: number;
  }): ReturnType<Deployment["useIngressProxyRoutes"]>;
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
      waitUntilHealthyTimeoutMs?: number | false;
    }): Promise<E2EAttachedDeploymentFixture>;
    fileSlug: string;
    testSlug: string;
    fullName: string;
    testId: string;
  };
}

export type { DeploymentLogsArtifact };
type TestOptionsWithTags = {
  tags?: string | readonly string[];
};

// Docs: https://vitest.dev/guide/test-context.html#test-extend
// Docs: https://vitest.dev/api/hooks#ontestfinished
// Design: tests that need artifacts should explicitly opt into this local base
// `test`. It creates one directory per test, keeps event logs next to
// `vitest-output.log`, records the final result in `result.json`, and exposes the
// whole artifact namespace as a single `{ e2e }` fixture.
const rawTest = baseTest.extend<E2EFixtures>({
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
            artifactDir: paths.artifactDir,
          });
          if (params.waitUntilHealthyTimeoutMs !== false) {
            await params.deployment.waitUntilHealthy({
              timeoutMs: params.waitUntilHealthyTimeoutMs ?? 60_000,
            });
          }
          return Object.assign(attached, {
            artifacts: {
              dir: paths.artifactDir,
              consoleLogPath: paths.outputLogPath,
              resultPath: paths.resultPath,
              logsPath: attached.artifactPath,
            },
            snapshot() {
              return params.deployment.snapshot();
            },
            async waitForArtifactText(waitParams: { needle: string; timeoutMs: number }) {
              const logsPath = attached.artifactPath;
              if (!logsPath) {
                throw new Error("useDeployment fixture has no artifact path");
              }

              const deadline = Date.now() + waitParams.timeoutMs;
              let lastBody = "";

              while (Date.now() < deadline) {
                try {
                  lastBody = await readFile(logsPath, "utf8");
                  if (lastBody.includes(waitParams.needle)) return;
                } catch {}
                await new Promise((resolve) => setTimeout(resolve, 200));
              }

              throw new Error(
                `Timed out waiting for artifact ${logsPath} to contain ${JSON.stringify(waitParams.needle)}${
                  lastBody ? `; last body: ${lastBody}` : ""
                }`,
              );
            },
            async useIngressProxyRoutes(
              routeParams: Parameters<E2EAttachedDeploymentFixture["useIngressProxyRoutes"]>[0],
            ) {
              const ingress = resolveIngressProxyConfig();
              return await params.deployment.useIngressProxyRoutes({
                ...routeParams,
                ingressProxyApiKey: ingress.ingressProxyApiKey,
                ingressProxyBaseUrl: ingress.ingressProxyBaseUrl,
                metadata: {
                  testId: task.id,
                  testName: task.fullName,
                  ...(routeParams.metadata ?? {}),
                },
              });
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

export function prefixTitleWithRawTags(title: string, options?: TestOptionsWithTags) {
  const tags =
    typeof options?.tags === "string"
      ? [options.tags]
      : Array.isArray(options?.tags)
        ? [...options.tags]
        : [];
  if (tags.length === 0) return title;
  return `[${tags.join(" ")}] ${title}`;
}

const wrappedTest = (title: string, optionsOrFn: unknown, maybeFn?: unknown) => {
  if (typeof optionsOrFn === "function") {
    return rawTest(title, optionsOrFn as never);
  }
  return rawTest(
    prefixTitleWithRawTags(title, optionsOrFn as TestOptionsWithTags | undefined),
    optionsOrFn as never,
    maybeFn as never,
  );
};

Object.defineProperties(wrappedTest, Object.getOwnPropertyDescriptors(rawTest));

export const test = wrappedTest as typeof rawTest;
