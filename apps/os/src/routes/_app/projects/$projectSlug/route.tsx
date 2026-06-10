import { Outlet, createFileRoute, notFound } from "@tanstack/react-router";
import type { Project } from "@iterate-com/os-contract";
import { getBrowserItx } from "~/itx/use-itx.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug")({
  // The project is resolved over the browser's itx socket, which never SSRs
  // (~/itx/use-itx.ts), so this layout — and with it every project child
  // route — renders client-side only.
  ssr: false,
  beforeLoad: async ({ params }) => ({
    project: await resolveProjectBySlug(params.projectSlug),
  }),
  loader: ({ context }) => {
    return {
      breadcrumb: context.project.slug,
    };
  },
  component: ProjectLayout,
});

/**
 * Resolve `context.project` for the whole project route tree from the global
 * itx handle. itx.projects.list is the one kernel call that returns the full
 * row (customHostname/createdAt/updatedAt — settings still reads them), and
 * it is already access-scoped: a user's handle lists exactly their projects,
 * so find-by-slug doubles as the access check. Admin (access "all") handles
 * page through the deployment-wide list until the slug shows up.
 */
async function resolveProjectBySlug(projectSlug: string): Promise<Project> {
  const itx = await getBrowserItx();
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const { projects, total } = await itx.projects.list({ limit: pageSize, offset });
    const match = projects.find((project) => project.slug === projectSlug);
    if (match) return { ...match, isOrphanedProjectFromAuthService: false };
    if (projects.length === 0 || offset + projects.length >= total) throw notFound();
  }
}

function ProjectLayout() {
  return <Outlet />;
}
