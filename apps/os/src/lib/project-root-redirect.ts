import type { ProjectDeploymentStatus } from "../project-deployment-status.ts";
import type { ProjectRpcTarget } from "../rpc-targets.ts";

export type RootRedirectProject = {
  id: string;
  slug: string;
  organizationId: string | null;
  deploymentStatus: ProjectDeploymentStatus;
};

export type RootProjectRedirectDecision =
  | {
      kind: "project";
      project: RootRedirectProject;
      welcome: boolean;
      /**
       * The server could not prove or commit this project's birth before the
       * redirect. The welcome page must issue the same idempotent create once
       * from its authenticated browser session instead of stranding the user
       * on the projects list.
       */
      ensureBirth: boolean;
    }
  | {
      kind: "projects";
    };

export function chooseRootProjectRedirect(input: {
  preferredProjectSlug: string | null;
  projects: RootRedirectProject[];
}): RootProjectRedirectDecision {
  const readyProjects = input.projects.filter((project) => project.deploymentStatus === "ready");
  const preferredReadyProject = readyProjects.find(
    (project) => project.slug === input.preferredProjectSlug,
  );

  if (preferredReadyProject) {
    return {
      kind: "project",
      project: preferredReadyProject,
      welcome: false,
      ensureBirth: false,
    };
  }

  if (readyProjects.length === 1) {
    return {
      kind: "project",
      project: readyProjects[0]!,
      welcome: false,
      ensureBirth: false,
    };
  }

  if (input.projects.length === 1 && input.projects[0]!.deploymentStatus !== "ready") {
    return {
      kind: "project",
      project: input.projects[0]!,
      welcome: true,
      // "unknown" means the deployment-status probe itself failed. Treat it
      // as uncertainty to heal, not evidence that a single-project user
      // belongs on a dead-end list page.
      ensureBirth: input.projects[0]!.deploymentStatus === "unknown",
    };
  }

  return { kind: "projects" };
}

/**
 * Commit a missing project's birth before the root SSR redirect, without
 * waiting for the bootstrap saga's `project/ready` event. The project home
 * renders that remaining progress from live state.
 */
export async function createMissingRootRedirectProject(
  project: Pick<ProjectRpcTarget, "create">,
  args: Parameters<ProjectRpcTarget["create"]>[0],
): Promise<void> {
  await project.create(args, { waitUntilReady: false });
}
