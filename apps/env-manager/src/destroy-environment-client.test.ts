import { describe, expect, test, vi } from "vitest";
import { destroyEnvironmentInBatches } from "./destroy-environment-client.ts";
import {
  recoverInterruptedEnvironmentState,
  type EnvironmentApi,
  type EnvironmentState,
} from "./state.ts";

const emptyState: EnvironmentState = {
  stage: "preview_1",
  lifecycle: "empty",
  progress: [],
};

function interruptedState(operationId: string): EnvironmentState {
  return recoverInterruptedEnvironmentState(
    {
      stage: "preview_1",
      lifecycle: "destroying",
      operationId,
      operationStartedAt: "2026-07-31T00:00:00.000Z",
      progress: [],
    },
    "2026-07-31T00:01:00.000Z",
  );
}

describe("destroy environment client", () => {
  test("resumes only the exact operation interrupted by a Durable Object restart", async () => {
    let interruptedOperationId: string | undefined;
    let destroys = 0;
    const close = vi.fn();
    const api: Pick<EnvironmentApi, "cancel" | "destroy" | "status"> = {
      cancel: vi.fn(),
      destroy: vi.fn(async (_confirmation, operationId) => {
        destroys += 1;
        if (destroys === 1) {
          interruptedOperationId = operationId;
          throw new Error("Cap'n Web session dropped");
        }
        return true;
      }),
      status: vi.fn(async () =>
        destroys === 1 ? interruptedState(interruptedOperationId ?? "missing") : emptyState,
      ),
    };

    await expect(
      destroyEnvironmentInBatches({
        stage: "preview_1",
        connect: () => ({ api, close }),
      }),
    ).resolves.toEqual(emptyState);
    expect(api.destroy).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(4);
  });

  test("does not resume after a failure from another operation", async () => {
    const failure = new Error("Cap'n Web session dropped");
    const api: Pick<EnvironmentApi, "cancel" | "destroy" | "status"> = {
      cancel: vi.fn(),
      destroy: vi.fn(async () => {
        throw failure;
      }),
      status: vi.fn(async () => interruptedState("another-operation")),
    };

    await expect(
      destroyEnvironmentInBatches({
        stage: "preview_1",
        connect: () => ({ api, close: vi.fn() }),
      }),
    ).rejects.toBe(failure);
    expect(api.destroy).toHaveBeenCalledTimes(1);
  });

  test("cancels the exact active operation when its caller loses ownership", async () => {
    const remote = Promise.withResolvers<boolean>();
    let operationId: string | undefined;
    const ownership = new AbortController();
    const api: Pick<EnvironmentApi, "cancel" | "destroy" | "status"> = {
      cancel: vi.fn(async (candidate) => {
        remote.reject(new Error("cancelled"));
        return candidate === operationId;
      }),
      destroy: vi.fn((_confirmation, candidate) => {
        operationId = candidate;
        return remote.promise;
      }),
      status: vi.fn(async () => emptyState),
    };

    const destroying = destroyEnvironmentInBatches({
      stage: "preview_1",
      connect: () => ({ api, close: vi.fn() }),
      signal: ownership.signal,
    });
    await vi.waitFor(() => expect(operationId).toBeDefined());
    const ownershipFailure = new Error("lease ownership lost");
    ownership.abort(ownershipFailure);

    await expect(destroying).rejects.toBe(ownershipFailure);
    expect(api.cancel).toHaveBeenCalledWith(operationId);
  });
});
