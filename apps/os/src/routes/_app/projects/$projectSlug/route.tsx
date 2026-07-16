import { Suspense } from "react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { ProjectScope } from "~/itx/itx-react.tsx";
import { ItxResourceLoading } from "~/components/itx-boundary.tsx";
import { getProjectBySlugServerFn } from "~/lib/project-server-fns.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug")({
  // <ProjectScope> pre-warms the one itx socket, which dials a WebSocket and
  // THROWS on the server (never SSRs). `ssr: false` here makes this match — and,
  // in TanStack Router, every child match (load-matches.ts forces
  // `parentMatch.ssr === false` down the tree) — client-only. The project itself
  // is read SSR-safe through a server function (itx is client-only), not itx.
  ssr: false,
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
  // The whole tab shares ONE itx session socket; <ProjectScope> carries this
  // project's slug so `useItx()` / `useItxQuery()` resolve without an explicit
  // argument (the browser passes the URL slug straight through, no slug→id hop)
  // AND pre-warms the socket in its own boundary so pages paint immediately.
  // Ordinary pages need no boundary of their own — the router wraps each match
  // in <Suspense>; this labelled one is the layout's own safety net.
  return (
    <Suspense fallback={<ItxResourceLoading label="project" />}>
      <ProjectScope slug={project.slug}>
        <Outlet />
      </ProjectScope>
    </Suspense>
  );
}
