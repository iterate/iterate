import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { ProjectAppShell } from "@iterate-com/ui/components/project-app-shell";

/** A project's docs, framed in the shell every OS app shares. */
export const Route = createFileRoute("/_auth/projects/$slug")({
  beforeLoad: async ({ context, params }) => {
    const projects = await context.api.projects.list();
    // the URL names the project by slug; one this sign-in lacks → sign in again
    const project = projects.find((item) => item.slug === params.slug);
    if (!project) return context.signInFor(params.slug);
    return { projects, project };
  },
  component: ProjectDocs,
});

function ProjectDocs() {
  const { projects, project, info, basePath } = Route.useRouteContext();
  const href = useRouterState({ select: (state) => state.location.href });
  return (
    <ProjectAppShell
      app="Docs"
      projects={projects}
      project={project}
      basePath={basePath}
      account={info.principal}
      locationKey={href}
    >
      <Outlet />
    </ProjectAppShell>
  );
}
