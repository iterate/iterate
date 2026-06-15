import { Suspense } from "react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { ItxProvider } from "~/itx/itx-react.tsx";
import { ItxResourceLoading } from "~/components/itx-boundary.tsx";
import { getProjectBySlugServerFn } from "~/lib/project-server-fns.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug")({
  // The layout pre-warms (and suspends on) the project itx socket via
  // <ItxProvider>, which dials a WebSocket and THROWS on the server (never
  // SSRs). `ssr: false` here makes this match — and, in TanStack Router, every
  // child match (load-matches.ts forces `parentMatch.ssr === false` down the
  // tree) — client-only, so the provider only ever runs in the browser. Child
  // leaves keep their own `ssr: false` + <ItxBoundary> too (harmless and
  // explicit); the provider just supplies the shared address + pre-warm. The
  // project itself is read SSR-safe through a server function (itx is
  // client-only), not itx.
  ssr: false,
  beforeLoad: async ({ params }) => ({
    project: await getProjectBySlugServerFn({ data: { slug: params.projectSlug } }),
  }),
  loader: ({ context }) => {
    return {
      breadcrumb: context.project.slug,
      project: context.project,
    };
  },
  component: ProjectLayout,
});

function ProjectLayout() {
  const { project } = Route.useRouteContext();
  // One shared project socket for every route under this layout. We key the
  // address on the project SLUG (the server resolves slug or id at /api/itx);
  // any route that must talk to the GLOBAL handle instead (e.g. settings'
  // hostname ops) calls `useItx({})` to force it.
  return (
    <Suspense fallback={<ItxResourceLoading label="project" />}>
      <ItxProvider projectId={project.slug}>
        <Outlet />
      </ItxProvider>
    </Suspense>
  );
}
