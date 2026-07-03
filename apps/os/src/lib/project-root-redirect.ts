import type { ProjectDeploymentStatus } from "~/types.ts";

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
    return { kind: "project", project: preferredReadyProject, welcome: false };
  }

  if (readyProjects.length === 1) {
    return { kind: "project", project: readyProjects[0]!, welcome: false };
  }

  if (input.projects.length === 1 && input.projects[0]!.deploymentStatus === "missing") {
    return { kind: "project", project: input.projects[0]!, welcome: true };
  }

  return { kind: "projects" };
}
