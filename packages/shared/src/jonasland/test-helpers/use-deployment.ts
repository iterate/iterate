import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import type {
  Deployment,
  DeploymentEvent,
  DeploymentExecResult,
} from "../deployment/deployment.ts";

type DeploymentLoggedEvent = Extract<
  DeploymentEvent,
  { type: "https://events.iterate.com/deployment/logged" }
>;

export interface UseDeploymentFixture extends AsyncDisposable {
  deployment: Deployment;
  artifactDir?: string;
  artifactPath?: string;
  getEvents(): readonly DeploymentEvent[];
  waitForShellSuccess(params: {
    cmd: string;
    timeoutMs: number;
    deployment?: Deployment;
  }): Promise<DeploymentExecResult>;
  waitUntilExecAvailable(params: { timeoutMs: number; deployment?: Deployment }): Promise<void>;
  waitForLogLine(params: {
    lineIncludes: string;
    timeoutMs: number;
  }): Promise<DeploymentLoggedEvent>;
  waitForEvent(params: {
    predicate: (event: DeploymentEvent) => boolean;
    timeoutMs: number;
  }): Promise<DeploymentEvent>;
}

type EventWaiter = {
  predicate: (event: DeploymentEvent) => boolean;
  resolve: (event: DeploymentEvent) => void;
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
   * const event = await fixture.waitForEvent({
   *   timeoutMs: 10_000,
   *   predicate: (event) =>
   *     event.type === "https://events.iterate.com/deployment/logged" &&
   *     event.payload.line.includes("needle"),
   * });
   * ```
   */
  const history: DeploymentEvent[] = [];
  const waiters: EventWaiter[] = [];
  let terminalError: Error | null = null;
  let disposed = false;
  const controller = new AbortController();
  const artifactPath = params.artifactDir
    ? join(params.artifactDir, "deployment-events.yaml")
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

  const onEvent = (event: DeploymentEvent) => {
    history.push(event);
    if (artifactPath) {
      void scheduleArtifactWrite();
    }
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  };

  const reader = (async () => {
    try {
      for await (const event of params.deployment.events({
        signal: controller.signal,
        logTail: params.logTail,
      })) {
        onEvent(event);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const resolved =
        error instanceof Error
          ? error
          : new Error(`Deployment event stream failed: ${String(error)}`);
      terminalError = resolved;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(resolved);
      }
    }
  })();

  const waitForEvent = async (waitParams: {
    predicate: (event: DeploymentEvent) => boolean;
    timeoutMs: number;
  }) => {
    const existing = history.find(waitParams.predicate);
    if (existing) return existing;
    if (terminalError) throw terminalError;
    if (disposed) throw new Error("useDeployment fixture already disposed");

    return await new Promise<DeploymentEvent>((resolve, reject) => {
      const waiter: EventWaiter = {
        predicate: waitParams.predicate,
        resolve: (event) => {
          clearTimeout(timeout);
          resolve(event);
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
            `Timed out after ${String(waitParams.timeoutMs)}ms waiting for deployment event`,
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
    getEvents() {
      return history;
    },
    async waitForShellSuccess(waitParams) {
      const targetDeployment = waitParams.deployment ?? params.deployment;
      const deadline = Date.now() + waitParams.timeoutMs;
      let lastResult: DeploymentExecResult | null = null;

      while (Date.now() < deadline) {
        const result = await targetDeployment.shell({ cmd: waitParams.cmd }).catch(() => null);
        if (result?.exitCode === 0) return result;
        lastResult = result ?? lastResult;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      throw new Error(
        `Timed out waiting for shell command to succeed${
          lastResult?.output ? `: ${lastResult.output}` : ""
        }`,
      );
    },
    async waitUntilExecAvailable(waitParams) {
      const targetDeployment = waitParams.deployment ?? params.deployment;
      const deadline = Date.now() + waitParams.timeoutMs;
      let lastOutput = "";

      while (Date.now() < deadline) {
        const result = await targetDeployment
          .shell({ cmd: "echo provider-exec-ready" })
          .catch(() => null);
        if (result?.exitCode === 0 && result.output.includes("provider-exec-ready")) {
          return;
        }
        lastOutput = result?.output ?? lastOutput;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      throw new Error(
        `Timed out waiting for exec availability${lastOutput ? `: ${lastOutput}` : ""}`,
      );
    },
    async waitForLogLine(waitParams) {
      return (await waitForEvent({
        timeoutMs: waitParams.timeoutMs,
        predicate: (event) =>
          event.type === "https://events.iterate.com/deployment/logged" &&
          event.payload.line.includes(waitParams.lineIncludes),
      })) as DeploymentLoggedEvent;
    },
    async waitForEvent(waitParams) {
      return await waitForEvent(waitParams);
    },
    async [Symbol.asyncDispose]() {
      disposed = true;
      controller.abort();
      if (params.destroyOnDispose ?? true) {
        await params.deployment.destroy();
      }
      await reader;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error("useDeployment fixture disposed before matching event arrived"));
      }
      void scheduleArtifactWrite().catch(() => {});
      if (artifactPath) {
        void writeArtifact({
          artifactPath,
          deployment: params.deployment,
          history,
        }).catch(() => {});
      }
    },
  };
}

async function writeArtifact(params: {
  artifactPath: string;
  deployment: Deployment;
  history: DeploymentEvent[];
}) {
  const payload = {
    deployment: params.deployment.snapshot(),
    writtenAt: new Date().toISOString(),
    events: params.history,
  };
  await writeFile(params.artifactPath, stringify(payload));
}
