import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import type { Deployment } from "../deployment/deployment.ts";
import type { DeploymentLogEntry } from "../deployment/deployment-provider-manifest.ts";

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

type LogWaiter = {
  predicate: (entry: DeploymentLogEntry) => boolean;
  resolve: (entry: DeploymentLogEntry) => void;
  reject: (error: Error) => void;
};

export async function useDeployment(params: {
  deployment: Deployment;
  logTail?: number;
  artifactDir?: string;
  destroyOnDispose?: boolean;
}): Promise<UseDeploymentFixture> {
  /**
   * Typical test usage:
   *
   * ```ts
   * await using tmp = await useTmpDir({ destroyOnDispose: false });
   * await using fixture = await useDeployment({
   *   deployment,
   *   artifactDir: tmp.path,
   * });
   *
   * const entry = await fixture.waitForLogLine({
   *   lineIncludes: "needle",
   *   timeoutMs: 10_000,
   * });
   * ```
   */
  const history: DeploymentLogEntry[] = [];
  const waiters: LogWaiter[] = [];
  let terminalError: Error | null = null;
  let disposed = false;
  const controller = new AbortController();
  const artifactPath = params.artifactDir
    ? join(params.artifactDir, "deployment-logs.yaml")
    : undefined;

  // Test event volume is small today, so keep full in-memory history for
  // straightforward assertions and debugging. If these streams get noisier or
  // longer-lived, this may need to become a bounded ring buffer.
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
  const deployment = params.deployment.snapshot();
  const payload: DeploymentLogsArtifact = {
    deployment,
    logs: params.history,
  };
  await writeFile(params.artifactPath, stringify(payload));
}
