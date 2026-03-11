import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import type { StoredEvent, TraceContext } from "@iterate-com/events-contract";
import type { Deployment, DeploymentEvent } from "../deployment/deployment.ts";

type DeploymentLoggedEvent = Extract<
  DeploymentEvent,
  { type: "https://events.iterate.com/deployment/logged" }
>;

export interface UseDeploymentFixture extends AsyncDisposable {
  deployment: Deployment;
  artifactDir?: string;
  artifactPath?: string;
  getEvents(): readonly DeploymentEvent[];
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

type RecordedDeploymentEvent = {
  sequence: number;
  observedAt: string;
  event: DeploymentEvent;
};

const SYNTHETIC_TRACE: TraceContext = {
  traceId: "00000000000000000000000000000000",
  spanId: "0000000000000000",
  parentSpanId: null,
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
  const history: RecordedDeploymentEvent[] = [];
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
          logTail: params.logTail,
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
    history.push({
      sequence: history.length + 1,
      observedAt: new Date().toISOString(),
      event,
    });
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
    const existing = history.find(({ event }) => waitParams.predicate(event))?.event;
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
      return history.map(({ event }) => event);
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
        waiter.reject(new Error("useDeployment fixture disposed before matching event arrived"));
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
  history: RecordedDeploymentEvent[];
  logTail?: number;
}) {
  const deployment = params.deployment.snapshot();
  const slug = deployment.slug;
  const path = slug ? `/deployment/${slug}` : "/deployment/unknown";
  const payload = {
    deployment,
    path,
    events: params.history.map(({ sequence, observedAt, event }) =>
      toStoredEvent({
        path,
        offset: formatOffset(sequence),
        createdAt: observedAt,
        event,
      }),
    ),
  };
  await writeFile(params.artifactPath, stringify(payload));
}

function toStoredEvent(params: {
  path: string;
  offset: string;
  createdAt: string;
  event: DeploymentEvent;
}): StoredEvent {
  return {
    path: params.path,
    offset: params.offset,
    createdAt: params.createdAt,
    trace: { ...SYNTHETIC_TRACE },
    type: params.event.type,
    payload: params.event.payload,
  };
}

function formatOffset(value: number) {
  return String(value).padStart(16, "0");
}
