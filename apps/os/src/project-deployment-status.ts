import type { ProjectProcessorState } from "./domains/projects/project-processor-contract.ts";

/**
 * Whether a project the directory knows about actually exists in THIS
 * deployment's engine:
 * - `created` — the project stream's bootstrap saga committed `project/created`.
 * - `creating` — `project/create-requested` exists but no terminal fact does.
 * - `failed` — the saga committed terminal `project/create-failed`.
 * - `missing` — the engine has no state for it (e.g. the deployment was reset
 *   while the auth worker kept its rows); it can be set up again.
 * - `unknown` — the probe failed (engine hiccup); don't block the list on it.
 */
export type ProjectDeploymentStatus = "created" | "creating" | "failed" | "missing" | "unknown";

/** The lifecycle projection every engine-state consumer must agree on. */
export function deploymentStatusFromState(
  state: Pick<ProjectProcessorState, "birthCertificate" | "createFailure" | "createRequest">,
): Exclude<ProjectDeploymentStatus, "unknown"> {
  if (state.birthCertificate !== null) return "created";
  if (state.createFailure !== null) return "failed";
  if (state.createRequest !== null) return "creating";
  return "missing";
}

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
 * Pure seam for the engine-existence probe: per-project lifecycle projections
 * from the project processor snapshot, or a rejection, → deployment statuses.
 * A rejected probe means "we could not tell", never "it does not exist".
 */
export function deploymentStatusesFromProbes(
  projectIds: readonly string[],
  outcomes: readonly PromiseSettledResult<Exclude<ProjectDeploymentStatus, "unknown">>[],
): Map<string, ProjectDeploymentStatus> {
  return new Map(
    projectIds.map((projectId, index) => {
      const outcome = outcomes[index];
      if (!outcome || outcome.status === "rejected") return [projectId, "unknown"];
      return [projectId, outcome.value];
    }),
  );
}
