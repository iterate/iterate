import { Suspense, useEffect } from "react";
import { ClientOnly, Outlet, createFileRoute } from "@tanstack/react-router";
import { ProjectScope, useIterateSession } from "iterate/sdk/itx/react";
import { ItxResourceLoading } from "~/components/itx-boundary.tsx";
import { OsAppClientPresence } from "~/components/os-app-client-presence.tsx";
import { getProjectBySlugServerFn } from "~/lib/project-server-fns.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug")({
  // Project identity is SSR-safe through a server function. Individual leaves
  // that require browser-only itx rendering opt out themselves; keeping that
  // boundary off the parent lets simple project pages render immediately.
  beforeLoad: async ({ params }) => ({
    project: await getProjectBySlugServerFn({ data: { slug: params.projectSlug } }),
  }),
  loader: ({ context }) => {
    return {
      breadcrumb: context.project.slug,
    };
  },
  component: ProjectLayout,
});

function ProjectLayout() {
  const { project } = Route.useRouteContext();
  useEffect(() => {
    document.cookie = `iterate_recent_project=${encodeURIComponent(project.slug)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, [project.slug]);
  // ProjectScope is a server-safe slug context. The whole tab still shares ONE
  // itx session socket; pre-warm that browser-only resource in an invisible,
  // narrowly scoped boundary so it cannot force the project route tree out of
  // SSR. The router wraps each route match in <Suspense>; this labelled outer
  // boundary remains the layout's safety net for leaf itx consumers.
  return (
    <Suspense fallback={<ItxResourceLoading label="project" />}>
      <ProjectScope slug={project.slug}>
        <ClientOnly fallback={null}>
          <Suspense fallback={null}>
            <ProjectSessionPrewarm />
            <OsAppClientPresence slug={project.slug} />
          </Suspense>
        </ClientOnly>
        <Outlet />
      </ProjectScope>
    </Suspense>
  );
}

function ProjectSessionPrewarm() {
  useIterateSession();
  return null;
}
