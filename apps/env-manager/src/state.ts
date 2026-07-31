import type { LiveStateRpc } from "iterate/sdk/capnweb";
import { z } from "zod";

export type EnvironmentStage = "prd" | "dev_global" | `preview_${number}`;

export const MAX_ENVIRONMENT_DESTROY_BATCHES = 100;
const ENVIRONMENT_DESTROY_RESTARTED_ERROR =
  "Environment manager restarted while destroying; retry the operation.";

export const EnvironmentStage = z.custom<EnvironmentStage>(
  (value) =>
    value === "prd" ||
    value === "dev_global" ||
    (typeof value === "string" && /^preview_[1-9]\d*$/.test(value)),
  "Expected prd, dev_global, or a preview stage such as preview_12.",
);

export const EnvironmentLifecycle = z.enum([
  "empty",
  "checking",
  "deploying",
  "ready",
  "destroying",
  "failed",
]);

export type EnvironmentLifecycle = z.infer<typeof EnvironmentLifecycle>;

export const ResourceProgress = z.strictObject({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  message: z.string().optional(),
});

export type ResourceProgress = z.infer<typeof ResourceProgress>;

export const EnvironmentResources = z.strictObject({
  kind: z.literal("platform"),
  stage: EnvironmentStage,
  authDbId: z.string(),
  projectDirectoryKvId: z.string(),
  workerBuildCacheKvId: z.string(),
  semaphoreDbId: z.string(),
  filesBucketName: z.string(),
  sandboxesBucketName: z.string(),
});

export type EnvironmentResources = z.infer<typeof EnvironmentResources>;

const AuthResources = z.strictObject({
  kind: z.literal("auth"),
  stage: EnvironmentStage,
  authDbId: z.string(),
});

export const AlchemyResources = z.discriminatedUnion("kind", [AuthResources, EnvironmentResources]);

export type AlchemyResources = z.infer<typeof AlchemyResources>;

export const PersistedEnvironmentState = z.strictObject({
  stage: EnvironmentStage,
  lifecycle: EnvironmentLifecycle,
  operationId: z.string().optional(),
  operationStartedAt: z.string().optional(),
  operationFinishedAt: z.string().optional(),
  lastError: z.string().optional(),
  progress: z.array(ResourceProgress),
});

export type PersistedEnvironmentState = z.infer<typeof PersistedEnvironmentState>;

export const EnvironmentState = PersistedEnvironmentState.extend({
  resources: AlchemyResources.optional(),
});

export type EnvironmentState = z.infer<typeof EnvironmentState>;

export function parsePersistedEnvironmentState(
  serialized: string,
  stage: EnvironmentStage,
): PersistedEnvironmentState {
  try {
    const state = PersistedEnvironmentState.parse(JSON.parse(serialized));
    if (state.stage !== stage) {
      throw new Error(`Stored state belongs to ${state.stage}, not ${stage}.`);
    }
    return state;
  } catch (cause) {
    return {
      stage,
      lifecycle: "failed",
      progress: [],
      lastError: `Stored environment-manager lifecycle state is invalid; deploy or destroy the environment to replace it. ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

export function persistedEnvironmentState(state: EnvironmentState): PersistedEnvironmentState {
  const { resources: _resources, ...persisted } = state;
  return PersistedEnvironmentState.parse(persisted);
}

export function reconcileEnvironmentState(
  state: PersistedEnvironmentState,
  resources: AlchemyResources | undefined,
): EnvironmentState {
  if (state.lifecycle === "empty" || state.lifecycle === "ready") {
    return {
      ...state,
      lifecycle: resources === undefined ? "empty" : "ready",
      resources,
    };
  }
  return { ...state, resources };
}

export function assertEnvironmentDestroyAllowed(input: {
  browserSession: boolean;
  confirmation: EnvironmentStage;
  stage: EnvironmentStage;
}): void {
  if (input.confirmation !== input.stage) {
    throw new Error(`Destroying ${input.stage} requires its exact stage as confirmation.`);
  }
  if (input.stage === "prd" && !input.browserSession) {
    throw new Error(
      "Production destruction requires an authenticated browser session; use the environment-manager dashboard.",
    );
  }
}

function isInterruptedEnvironmentDestroy(state: EnvironmentState): boolean {
  return (
    state.lifecycle === "failed" &&
    state.operationId !== undefined &&
    state.operationFinishedAt !== undefined &&
    state.lastError === ENVIRONMENT_DESTROY_RESTARTED_ERROR
  );
}

export function assertEnvironmentOperationAllowed(
  state: EnvironmentState,
  lifecycle: "checking" | "deploying" | "destroying",
): void {
  if (
    lifecycle !== "destroying" &&
    (state.lifecycle === "destroying" || isInterruptedEnvironmentDestroy(state))
  ) {
    throw new Error(
      `${state.stage} has a partial destroy to complete before another lifecycle operation may start.`,
    );
  }
}

const interruptedLifecycles = new Set<EnvironmentLifecycle>([
  "checking",
  "deploying",
  "destroying",
]);

export function recoverInterruptedEnvironmentState(
  state: PersistedEnvironmentState,
  recoveredAt: string,
): PersistedEnvironmentState {
  if (!interruptedLifecycles.has(state.lifecycle) || state.operationFinishedAt !== undefined) {
    return state;
  }
  return {
    ...state,
    lifecycle: "failed",
    operationFinishedAt: recoveredAt,
    lastError:
      state.lifecycle === "destroying"
        ? ENVIRONMENT_DESTROY_RESTARTED_ERROR
        : `Environment manager restarted while ${state.lifecycle}; retry the operation.`,
  };
}

export function wasEnvironmentDestroyInterrupted(
  state: EnvironmentState,
  operationId: string,
): boolean {
  return isInterruptedEnvironmentDestroy(state) && state.operationId === operationId;
}

export type EnvironmentApi = {
  liveState: LiveStateRpc<EnvironmentState>;
  status(): Promise<EnvironmentState>;
  deploy(): Promise<void>;
  destroy(confirmation: EnvironmentStage, operationId?: string): Promise<boolean>;
  cancel(operationId: string): Promise<boolean>;
  check(): Promise<void>;
};
