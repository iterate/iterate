import { deployedPreviewEnvs, previewEnvironmentSlotNumber } from "../../../envs.ts";
import type { PreviewStage } from "./state.ts";

/**
 * The environment manager's complete inventory.
 *
 * This is a normal static import, not a runtime configuration lookup. Vite
 * compiles the selected, non-secret fields from the root envs.ts into the
 * Worker and browser bundles; editing the inventory therefore requires an
 * env-manager deployment.
 */
export const previewEnvironments = deployedPreviewEnvs.map((environment) => ({
  stage: environment.dopplerConfig as PreviewStage,
  slot: previewEnvironmentSlotNumber(environment),
  baseUrl: environment.baseUrl,
  osWorkerName: environment.osWorkerName,
}));

const previewStages = new Set<string>(previewEnvironments.map(({ stage }) => stage));

export function isCompiledPreviewStage(value: string): value is PreviewStage {
  return previewStages.has(value);
}

export function getPreviewEnvironment(stage: PreviewStage) {
  const environment = previewEnvironments.find((candidate) => candidate.stage === stage);
  if (environment === undefined) {
    throw new Error(
      `Preview environment ${JSON.stringify(stage)} is not compiled into env-manager.`,
    );
  }
  return environment;
}
