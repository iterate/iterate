import type { ProjectDeploymentStatus } from "./types.ts";

/**
 * Pure seam for the engine-existence probe: per-project outcomes (`created`
 * from the project processor snapshot, or a rejection) → deployment statuses.
 * A rejected probe means "we could not tell", never "it does not exist".
 */
export function deploymentStatusesFromProbes(
  projectIds: readonly string[],
  outcomes: readonly PromiseSettledResult<boolean>[],
): Map<string, ProjectDeploymentStatus> {
  return new Map(
    projectIds.map((projectId, index) => {
      const outcome = outcomes[index];
      if (!outcome || outcome.status === "rejected") return [projectId, "unknown"];
      return [projectId, outcome.value ? "ready" : "missing"];
    }),
  );
}
