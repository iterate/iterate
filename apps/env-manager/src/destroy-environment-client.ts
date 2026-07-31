import {
  EnvironmentState,
  MAX_ENVIRONMENT_DESTROY_BATCHES,
  wasEnvironmentDestroyInterrupted,
  type EnvironmentApi,
  type EnvironmentStage,
} from "./state.ts";

type EnvironmentConnection = {
  api: Pick<EnvironmentApi, "cancel" | "destroy" | "status">;
  close(): void;
};

type Connect = () => EnvironmentConnection | Promise<EnvironmentConnection>;

async function readEnvironmentState(connect: Connect): Promise<EnvironmentState> {
  const connection = await connect();
  try {
    return EnvironmentState.parse(await connection.api.status());
  } finally {
    connection.close();
  }
}

type DestroyRaceResult =
  | { kind: "completed"; complete: boolean }
  | { kind: "aborted"; reason: unknown };

async function destroyEnvironmentBatch(
  stage: EnvironmentStage,
  connect: Connect,
  signal?: AbortSignal,
): Promise<boolean> {
  const operationId = crypto.randomUUID();
  const connection = await connect();
  try {
    signal?.throwIfAborted();
    const remote = connection.api.destroy(stage, operationId);
    let complete: boolean;
    try {
      if (signal === undefined) {
        complete = await remote;
      } else {
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<DestroyRaceResult>((resolve) => {
          onAbort = () =>
            resolve({
              kind: "aborted",
              reason: signal.reason ?? new Error("Environment destroy aborted."),
            });
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          const first = await Promise.race<DestroyRaceResult>([
            remote.then((remoteComplete) => ({
              kind: "completed",
              complete: remoteComplete,
            })),
            aborted,
          ]);
          if (first.kind === "aborted") {
            let cancelled: boolean;
            try {
              cancelled = await connection.api.cancel(operationId);
            } catch (cause) {
              await remote.catch(() => undefined);
              throw new AggregateError(
                [first.reason, cause],
                `Destroying ${stage} lost its lease fence and the manager cancellation call failed.`,
              );
            }
            if (!cancelled) {
              await remote.catch(() => undefined);
              throw new Error(
                `Destroying ${stage} lost its lease fence, but operation ${operationId} was no longer active.`,
                { cause: first.reason },
              );
            }
            await remote.catch(() => undefined);
            throw first.reason;
          }
          complete = first.complete;
        } finally {
          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      }
    } catch (cause) {
      signal?.throwIfAborted();
      const state = await readEnvironmentState(connect);
      if (state.operationId === operationId && state.operationFinishedAt !== undefined) {
        if (state.lifecycle === "empty") return true;
        if (state.lifecycle === "destroying") return false;
      }
      if (wasEnvironmentDestroyInterrupted(state, operationId)) return false;
      throw cause;
    }
    if (!complete) {
      const state = EnvironmentState.parse(await connection.api.status());
      if (state.lifecycle !== "destroying" || state.operationFinishedAt === undefined) {
        throw new Error(
          `Destroying ${stage} returned a partial result without a settled destroying lifecycle.`,
        );
      }
    }
    return complete;
  } finally {
    connection.close();
  }
}

/**
 * Destroy through bounded manager operations. Every request has an exact
 * operation ID, so a fresh connection resumes only an operation interrupted
 * by a Durable Object restart. Lease-fenced callers may additionally attach
 * cancellation and an ownership check to every batch.
 */
export async function destroyEnvironmentInBatches(input: {
  stage: EnvironmentStage;
  connect: Connect;
  signal?: AbortSignal;
  verifyOwnership?: () => Promise<void>;
}): Promise<EnvironmentState> {
  for (let batch = 1; batch <= MAX_ENVIRONMENT_DESTROY_BATCHES; batch += 1) {
    input.signal?.throwIfAborted();
    await input.verifyOwnership?.();
    if (await destroyEnvironmentBatch(input.stage, input.connect, input.signal)) {
      const state = await readEnvironmentState(input.connect);
      if (state.lifecycle !== "empty") {
        throw new Error(
          `Destroying ${input.stage} completed but canonical environment state is ${state.lifecycle}, not empty.`,
        );
      }
      return state;
    }
  }
  throw new Error(
    `Destroying ${input.stage} did not converge after ${MAX_ENVIRONMENT_DESTROY_BATCHES} bounded batches; canonical Cloudflare inventory still contains resources.`,
  );
}
