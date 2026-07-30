import type { LiveStateRpc } from "iterate/sdk/capnweb";
import { z } from "zod";

export type EnvironmentStage = "prd" | "dev_global" | `preview_${number}`;

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

export const EnvironmentState = z.strictObject({
  stage: EnvironmentStage,
  lifecycle: EnvironmentLifecycle,
  operationStartedAt: z.string().optional(),
  operationFinishedAt: z.string().optional(),
  lastError: z.string().optional(),
  resources: AlchemyResources.optional(),
  progress: z.array(ResourceProgress),
});

export type EnvironmentState = z.infer<typeof EnvironmentState>;

export function parsePersistedEnvironmentState(
  serialized: string,
  stage: EnvironmentStage,
): EnvironmentState {
  try {
    const state = EnvironmentState.parse(JSON.parse(serialized));
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

const interruptedLifecycles = new Set<EnvironmentLifecycle>([
  "checking",
  "deploying",
  "destroying",
]);

export function recoverInterruptedEnvironmentState(
  state: EnvironmentState,
  recoveredAt: string,
): EnvironmentState {
  if (!interruptedLifecycles.has(state.lifecycle)) return state;
  return {
    ...state,
    lifecycle: "failed",
    operationFinishedAt: recoveredAt,
    lastError: `Environment manager restarted while ${state.lifecycle}; retry the operation.`,
  };
}

export type EnvironmentApi = {
  liveState: LiveStateRpc<EnvironmentState>;
  status(): Promise<EnvironmentState>;
  deploy(): Promise<void>;
  destroy(confirmation: EnvironmentStage): Promise<void>;
  check(): Promise<void>;
};
