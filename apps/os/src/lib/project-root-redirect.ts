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
  const openProjects = input.projects.filter(
    (project) => project.deploymentStatus === "created" || project.deploymentStatus === "creating",
  );
  const preferredOpenProject = openProjects.find(
    (project) => project.slug === input.preferredProjectSlug,
  );

  if (preferredOpenProject) {
    return {
      kind: "project",
      project: preferredOpenProject,
      welcome: preferredOpenProject.deploymentStatus === "creating",
      ensureBirth: false,
    };
  }

  const createdProjects = openProjects.filter((project) => project.deploymentStatus === "created");
  if (createdProjects.length === 1) {
    return {
      kind: "project",
      project: createdProjects[0]!,
      welcome: false,
      ensureBirth: false,
    };
  }
  if (openProjects.length === 1) {
    return {
      kind: "project",
      project: openProjects[0]!,
      welcome: true,
      ensureBirth: false,
    };
  }

  const onlyProject = input.projects.length === 1 ? input.projects[0]! : undefined;
  if (onlyProject?.deploymentStatus === "missing" || onlyProject?.deploymentStatus === "unknown") {
    return {
      kind: "project",
      project: onlyProject,
      welcome: true,
      // "unknown" means the deployment-status probe itself failed. Treat it
      // as uncertainty to heal, not evidence that a single-project user
      // belongs on a dead-end list page.
      ensureBirth: onlyProject.deploymentStatus === "unknown",
    };
  }

  return { kind: "projects" };
}

/**
 * Commit a missing project's birth before the root SSR redirect, without
 * waiting for the bootstrap saga's terminal `project/created` event. The project home
 * renders that remaining progress from live state.
 */
export async function createMissingRootRedirectProject(
  project: Pick<ProjectRpcTarget, "create">,
  args: Parameters<ProjectRpcTarget["create"]>[0],
): Promise<void> {
  await project.create(args, { waitUntilCreated: false });
}
