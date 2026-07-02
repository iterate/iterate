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
    };
  },
  component: ProjectLayout,
});

function ProjectLayout() {
  const { project } = Route.useRouteContext();
  // One shared project socket for every route under this layout, keyed by the
  // project ID: context resolution is client-side on itx
  // (authenticate() then projects.get(id)), so the address must be the id the
  // itx knows, not the slug. Routes that need the GLOBAL session instead
  // call `useItx({})` to force it.
  return (
    <Suspense fallback={<ItxResourceLoading label="project" />}>
      <ItxProvider projectId={project.id}>
        <Outlet />
      </ItxProvider>
    </Suspense>
  );
}
