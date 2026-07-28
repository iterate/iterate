import {
  waitForDurableObjectDeploymentVersion,
  type DeploymentVersionReadinessOptions,
} from "../durable-object-deployment-readiness.ts";

type WaitForCapabilityHostDeploymentVersionInput = DeploymentVersionReadinessOptions & {
  executionId: string;
  expectedVersion: string;
  path: string;
  readVersion: () => Promise<string>;
};

function notStartedError(
  input: WaitForCapabilityHostDeploymentVersionInput,
  detail: string,
  cause?: unknown,
): Error {
  const message =
    `Capability host at "${input.path}" was not ready for deployment version ` +
    `"${input.expectedVersion}" before script execution "${input.executionId}" was requested: ` +
    `${detail}. The script was not requested and did not run.`;
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
): Promise<{
  lifecycleFailures: number;
  mismatches: number;
  probeTimeouts: number;
  probes: number;
  waitedMs: number;
}> {
  return await waitForDurableObjectDeploymentVersion({
    ...input,
    notReadyError: (detail, cause) => notStartedError(input, detail, cause),
  });
}
