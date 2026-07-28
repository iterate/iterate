import {
  acquireDurableObjectDeploymentTarget,
  describeDeploymentVersion,
  waitForDurableObjectDeploymentVersion,
  type DeploymentVersionReadiness,
  type DeploymentVersionReadinessOptions,
  type DurableObjectDeploymentTarget,
  type WorkerDeploymentVersionLike,
} from "../durable-object-deployment-readiness.ts";
import type { ProvideCapabilityInput } from "./types.ts";

type WaitForCapabilityHostDeploymentVersionInput = DeploymentVersionReadinessOptions & {
  executionId: string;
  expectedVersion: WorkerDeploymentVersionLike;
  path: string;
  readVersion: () => Promise<WorkerDeploymentVersionLike>;
};

type CapabilityHostMountTarget = DurableObjectDeploymentTarget & {
  provideCapability: (
    input: ProvideCapabilityInput,
  ) =>
    | PromiseLike<{ path: string[]; providedAtOffset: number }>
    | { path: string[]; providedAtOffset: number };
};

type ProvideCapabilityOnDeploymentReadyHostInput = {
  expectedVersion: WorkerDeploymentVersionLike;
  getTarget: () => CapabilityHostMountTarget;
  input: ProvideCapabilityInput;
  path: string;
  projectId: string;
};

function notStartedError(
  input: WaitForCapabilityHostDeploymentVersionInput,
  detail: string,
  cause?: unknown,
): Error {
  const message =
    `Capability host at "${input.path}" was not ready for deployment version ` +
    `${describeDeploymentVersion(input.expectedVersion)} before script execution ` +
    `"${input.executionId}" was requested: ${detail}. ` +
    "The script was not requested and did not run.";
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

/**
 * Do not journal arbitrary script work onto a stale CapabilityHost incarnation.
 *
 * Preview requests are pinned to the freshly uploaded edge version, but an
 * existing Durable Object can still serve the previous version until the
 * rollout resets it. A script cannot be replayed once it starts because its
 * external effects may have happened, so this read-only guard waits at the
 * last safe boundary. Mismatches and one lifecycle reset are bounded by one
 * short deadline; application failures and a second reset stay observable.
 */
export async function waitForCapabilityHostDeploymentVersion(
  input: WaitForCapabilityHostDeploymentVersionInput,
): Promise<DeploymentVersionReadiness> {
  return await waitForDurableObjectDeploymentVersion({
    ...input,
    notReadyError: (detail, cause) => notStartedError(input, detail, cause),
  });
}

function notProvidedError(
  input: ProvideCapabilityOnDeploymentReadyHostInput,
  detail: string,
  cause?: unknown,
): Error {
  const mountPath = input.input.path.join(".");
  const message =
    `Capability host at "${input.path}" was not ready for deployment version ` +
    `${describeDeploymentVersion(input.expectedVersion)} before capability "${mountPath}" ` +
    `was provided: ${detail}. The capability was not mounted and its provider was not retained.`;
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

/**
 * A live capability carries a caller-owned RPC target which cannot be replayed
 * after an ambiguous reset. Probe with fresh stubs, then provide on the exact
 * ready stub at the final read-only boundary.
 */
export async function provideCapabilityOnDeploymentReadyHost(
  input: ProvideCapabilityOnDeploymentReadyHostInput,
  readinessOptions: DeploymentVersionReadinessOptions = {},
): Promise<{
  provision: { path: string[]; providedAtOffset: number };
  readiness: DeploymentVersionReadiness;
}> {
  const { readiness, target } = await acquireDurableObjectDeploymentTarget({
    ...readinessOptions,
    expectedVersion: input.expectedVersion,
    getTarget: input.getTarget,
    notReadyError: (detail, cause) => notProvidedError(input, detail, cause),
  });
  if (readiness.probes > 1 || readiness.targetNewer) {
    console.info("capability host deployment version converged before capability provide", {
      expectedDeploymentVersion: input.expectedVersion,
      lifecycleFailures: readiness.lifecycleFailures,
      mismatches: readiness.mismatches,
      mountPath: input.input.path,
      observedDeploymentVersion: readiness.observedVersion,
      path: input.path,
      probeTimeouts: readiness.probeTimeouts,
      probes: readiness.probes,
      projectId: input.projectId,
      targetNewer: readiness.targetNewer,
      waitedMs: readiness.waitedMs,
    });
  }
  return {
    provision: await target.provideCapability(input.input),
    readiness,
  };
}
