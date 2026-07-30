import type { LiveStateRpc } from "iterate/sdk/capnweb";
import { z } from "zod";

export type PreviewStage = `preview_${number}`;

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
  authDbId: z.string(),
});

export const AlchemyResources = z.discriminatedUnion("kind", [AuthResources, EnvironmentResources]);

export type AlchemyResources = z.infer<typeof AlchemyResources>;

export const EnvironmentState = z.strictObject({
  stage: z.custom<PreviewStage>((value) => /^preview_[1-9]\d*$/.test(String(value))),
  lifecycle: EnvironmentLifecycle,
  operationStartedAt: z.string().optional(),
  operationFinishedAt: z.string().optional(),
  lastError: z.string().optional(),
  resources: EnvironmentResources.optional(),
  progress: z.array(ResourceProgress),
});

export type EnvironmentState = z.infer<typeof EnvironmentState>;

export type EnvironmentApi = {
  liveState: LiveStateRpc<EnvironmentState>;
  status(): Promise<EnvironmentState>;
  deploy(): Promise<void>;
  destroy(): Promise<void>;
  check(): Promise<void>;
};
