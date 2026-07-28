import {
  acquireDurableObjectDeploymentTarget,
  describeDeploymentVersion,
  type DeploymentVersionReadiness,
  type DeploymentVersionReadinessOptions,
  type DurableObjectDeploymentTarget,
  type WorkerDeploymentVersionLike,
} from "../durable-object-deployment-readiness.ts";

type WaitForProjectBirthDeploymentVersionInput = {
  expectedVersion: WorkerDeploymentVersionLike;
  getTarget: () => DurableObjectDeploymentTarget;
  projectId: string;
};

/**
 * Project birth facts immediately wake the Project Durable Object, which then
 * emits sibling-creation facts. During a rolling deployment, prove that exact
 * processor is current before committing the facts: otherwise old processor
 * code can append payloads that the already-current sibling streams reject.
 */
export async function waitForProjectBirthDeploymentVersion(
  input: WaitForProjectBirthDeploymentVersionInput,
  readinessOptions: DeploymentVersionReadinessOptions = {},
): Promise<DeploymentVersionReadiness> {
  const { readiness } = await acquireDurableObjectDeploymentTarget({
    ...readinessOptions,
    expectedVersion: input.expectedVersion,
    getTarget: input.getTarget,
    notReadyError: (detail, cause) => {
      const message =
        `Project "${input.projectId}" has an identity and directory entry, but its Project ` +
        `Durable Object was not ready for deployment version ` +
        `${describeDeploymentVersion(input.expectedVersion)} before this create attempt appended ` +
        `root birth facts: ${detail}. This attempt appended no new birth facts; facts from any ` +
        "earlier identical call remain authoritative, and another identical create call safely " +
        "rejoins the registered project.";
      return cause === undefined ? new Error(message) : new Error(message, { cause });
    },
  });
  if (readiness.probes > 1 || readiness.targetNewer) {
    console.info("project Durable Object deployment version converged before birth append", {
      expectedDeploymentVersion: input.expectedVersion,
      lifecycleFailures: readiness.lifecycleFailures,
      mismatches: readiness.mismatches,
      observedDeploymentVersion: readiness.observedVersion,
      platformFailures: readiness.platformFailures,
      probeTimeouts: readiness.probeTimeouts,
      probes: readiness.probes,
      projectId: input.projectId,
      targetNewer: readiness.targetNewer,
      waitedMs: readiness.waitedMs,
    });
  }
  return readiness;
}
