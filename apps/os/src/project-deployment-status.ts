/**
 * Whether a project the directory knows about actually exists in THIS
 * deployment's engine:
 * - `ready` — the project stream's bootstrap saga ran (`state.ready`).
 * - `missing` — the engine has no state for it (e.g. the deployment was reset
 *   while the auth worker kept its rows); it can be set up again.
 * - `unknown` — the probe failed (engine hiccup); don't block the list on it.
 */
export type ProjectDeploymentStatus = "ready" | "missing" | "unknown";

/** One entry of a session's project catalog (`session.projects.list()`). */
export type ProjectListEntry = {
  id: string;
  slug: string;
  organizationId: string | null;
  organizationName: string | null;
  organizationSlug: string | null;
  deploymentStatus: ProjectDeploymentStatus;
};

/**
 * Pure seam for the engine-existence probe: per-project outcomes (`ready`
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
