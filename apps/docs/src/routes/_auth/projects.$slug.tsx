import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";
import { ProjectAppShell } from "@iterate-com/ui/components/project-app-shell";
import { DocsNav } from "../../components/docs-nav.tsx";
import { DocList, DocListContext } from "../../lib/doc-list.ts";

/** A project's docs, framed in the shell every OS app shares, the docs as a tree in its sidebar. */
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
  const { projects, project, info, basePath, api } = Route.useRouteContext();
  const { slug } = Route.useParams();
  const href = useRouterState({ select: (state) => state.location.href });
  // one list for the project's pages: the sidebar's tree and the doc list read the same one
  const docList = useMemo(() => new DocList(() => api.projects.get(project.id)), [api, project.id]);
  return (
    <DocListContext value={docList}>
      <ProjectAppShell
        app="Docs"
        projects={projects}
        project={project}
        basePath={basePath}
        account={info.principal}
        locationKey={href}
        nav={<DocsNav slug={slug} />}
      >
        <Outlet />
      </ProjectAppShell>
    </DocListContext>
  );
}
