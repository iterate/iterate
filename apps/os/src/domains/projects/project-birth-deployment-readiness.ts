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
  targetKind: "Project Durable Object" | "Stream Durable Object";
};

/**
 * Project birth facts are committed to the root Stream Durable Object and
 * immediately wake the Project Durable Object, which then emits
 * sibling-creation facts. During a rolling deployment, prove both exact
 * objects are current before committing the facts: otherwise either object
 * can reset while the birth operation crosses the rollout boundary.
 */
export async function waitForProjectBirthDeploymentVersion<
  Target extends DurableObjectDeploymentTarget,
>(
  input: Omit<WaitForProjectBirthDeploymentVersionInput, "getTarget"> & {
    getTarget: () => Target;
  },
  readinessOptions: DeploymentVersionReadinessOptions = {},
): Promise<{ readiness: DeploymentVersionReadiness; target: Target }> {
  const result = await acquireDurableObjectDeploymentTarget({
    ...readinessOptions,
    expectedVersion: input.expectedVersion,
    getTarget: input.getTarget,
    notReadyError: (detail, cause) => {
      const message =
        `Project "${input.projectId}" has an identity and directory entry, but its ` +
        `${input.targetKind} was not ready for deployment version ` +
        `${describeDeploymentVersion(input.expectedVersion)} before this create attempt appended ` +
        `root birth facts: ${detail}. This attempt appended no new birth facts; facts from any ` +
        "earlier identical call remain authoritative, and another identical create call safely " +
        "rejoins the registered project.";
      return cause === undefined ? new Error(message) : new Error(message, { cause });
    },
  });
  const { readiness } = result;
  if (readiness.probes > 1 || readiness.targetNewer) {
    console.info("project birth Durable Object deployment version converged before append", {
      expectedDeploymentVersion: input.expectedVersion,
      lifecycleFailures: readiness.lifecycleFailures,
      mismatches: readiness.mismatches,
      observedDeploymentVersion: readiness.observedVersion,
      platformFailures: readiness.platformFailures,
      probeTimeouts: readiness.probeTimeouts,
      probes: readiness.probes,
      projectId: input.projectId,
      targetKind: input.targetKind,
      targetNewer: readiness.targetNewer,
      waitedMs: readiness.waitedMs,
    });
  }
  return result;
}
