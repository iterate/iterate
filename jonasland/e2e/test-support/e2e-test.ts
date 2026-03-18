import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inject, test as baseTest } from "vitest";
import { createDeploymentSlug } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import type { DeploymentLogEntry } from "@iterate-com/shared/jonasland/deployment/deployment-provider-manifest.ts";
import type { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { stringify } from "yaml";
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
      waitUntilHealthy?: boolean;
    }): Promise<E2EAttachedDeploymentFixture>;
    fileSlug: string;
    testSlug: string;
    fullName: string;
    testId: string;
  };
}

export interface DeploymentLogsArtifact {
  deployment: ReturnType<Deployment["snapshot"]>;
  logs: DeploymentLogEntry[];
}

export interface UseDeploymentFixture extends AsyncDisposable {
  deployment: Deployment;
  artifactDir?: string;
  artifactPath?: string;
  getLogs(): readonly DeploymentLogEntry[];
  waitUntilExecAvailable(params: { timeoutMs: number; deployment?: Deployment }): Promise<void>;
  waitForLogLine(params: { lineIncludes: string; timeoutMs: number }): Promise<DeploymentLogEntry>;
}

type TestOptionsWithTags = {
  tags?: string | readonly string[];
};

type LogWaiter = {
  predicate: (entry: DeploymentLogEntry) => boolean;
  resolve: (entry: DeploymentLogEntry) => void;
  reject: (error: Error) => void;
};

async function createUseDeployment(params: {
  deployment: Deployment;
  logTail?: number;
  artifactDir?: string;
  destroyOnDispose?: boolean;
}): Promise<UseDeploymentFixture> {
  const history: DeploymentLogEntry[] = [];
  const waiters: LogWaiter[] = [];
  let terminalError: Error | null = null;
  let disposed = false;
  const controller = new AbortController();
  const artifactPath = params.artifactDir
    ? join(params.artifactDir, "deployment-logs.yaml")
    : undefined;

  let artifactDirty = false;
  let artifactWrite: Promise<void> | null = null;

  const scheduleArtifactWrite = () => {
    if (!artifactPath) return Promise.resolve();
    artifactDirty = true;
    if (artifactWrite) return artifactWrite;
    artifactWrite = (async () => {
      while (artifactDirty) {
        artifactDirty = false;
        await writeArtifact({
          artifactPath,
          deployment: params.deployment,
          history,
        });
      }
      artifactWrite = null;
    })();
    return artifactWrite;
  };

  if (artifactPath) {
    await mkdir(params.artifactDir!, { recursive: true });
    await scheduleArtifactWrite();
  }

  const onLog = (entry: DeploymentLogEntry) => {
    history.push(entry);
    if (artifactPath) {
      void scheduleArtifactWrite();
    }
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(entry)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(entry);
    }
  };

  const reader = (async () => {
    try {
      for await (const entry of params.deployment.logs({
        signal: controller.signal,
        tail: params.logTail,
      })) {
        onLog(entry);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const resolved =
        error instanceof Error
          ? error
          : new Error(`Deployment log stream failed: ${String(error)}`);
      terminalError = resolved;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(resolved);
      }
    }
  })();

  const waitForLog = async (waitParams: {
    predicate: (entry: DeploymentLogEntry) => boolean;
    timeoutMs: number;
  }) => {
    const existing = history.find((entry) => waitParams.predicate(entry));
    if (existing) return existing;
    if (terminalError) throw terminalError;
    if (disposed) throw new Error("useDeployment fixture already disposed");

    return await new Promise<DeploymentLogEntry>((resolve, reject) => {
      const waiter: LogWaiter = {
        predicate: waitParams.predicate,
        resolve: (entry) => {
          clearTimeout(timeout);
          resolve(entry);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
      const timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(
          new Error(
            `Timed out after ${String(waitParams.timeoutMs)}ms waiting for deployment log entry`,
          ),
        );
      }, waitParams.timeoutMs);
      waiters.push(waiter);
    });
  };

  return {
    deployment: params.deployment,
    artifactDir: params.artifactDir,
    artifactPath,
    getLogs() {
      return history;
    },
    async waitUntilExecAvailable(waitParams) {
      const targetDeployment = waitParams.deployment ?? params.deployment;
      await targetDeployment.shellWithRetry({
        cmd: "echo provider-exec-ready",
        timeoutMs: waitParams.timeoutMs,
        retryIf: (result) =>
          result.exitCode !== 0 || !result.output.includes("provider-exec-ready"),
      });
    },
    async waitForLogLine(waitParams) {
      return await waitForLog({
        timeoutMs: waitParams.timeoutMs,
        predicate: (entry) => entry.text.includes(waitParams.lineIncludes),
      });
    },
    async [Symbol.asyncDispose]() {
      if (process.env.E2E_NO_DISPOSE) return;
      disposed = true;
      let disposeError: unknown;
      try {
        if (params.destroyOnDispose ?? true) {
          await params.deployment.destroy();
        }
      } catch (error) {
        disposeError = error;
      }
      controller.abort();
      await reader;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(
          new Error("useDeployment fixture disposed before matching log entry arrived"),
        );
      }
      await scheduleArtifactWrite();
      if (disposeError) {
        throw disposeError;
      }
    },
  };
}

async function writeArtifact(params: {
  artifactPath: string;
  deployment: Deployment;
  history: DeploymentLogEntry[];
}) {
  const payload: DeploymentLogsArtifact = {
    deployment: params.deployment.snapshot(),
    logs: params.history,
  };
  await writeFile(params.artifactPath, stringify(payload));
}

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
          if (params.waitUntilHealthy ?? true) {
            await params.deployment.waitUntilHealthy();
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
