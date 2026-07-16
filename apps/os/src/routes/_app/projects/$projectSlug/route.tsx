import { Suspense } from "react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { ItxProvider, ProjectScope } from "~/itx/itx-react.tsx";
import { ItxResourceLoading } from "~/components/itx-boundary.tsx";
import { getProjectBySlugServerFn } from "~/lib/project-server-fns.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug")({
  // The layout pre-warms the project itx socket via <ItxProvider>, which
  // dials a WebSocket and THROWS on the server (never SSRs). `ssr: false`
  // here makes this match — and, in TanStack Router, every child match
  // (load-matches.ts forces `parentMatch.ssr === false` down the tree) —
  // client-only, so the provider only ever runs in the browser. Child leaves
  // keep their own `ssr: false` + <ItxBoundary> too (harmless and explicit);
  // the provider just supplies the shared address + pre-warm. The project
  // itself is read SSR-safe through a server function (itx is client-only),
  // not itx.
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
  // The whole tab shares ONE itx session socket; <ProjectScope> just carries
  // this project's slug so `useItx()` / `useItxQuery()` resolve without an
  // explicit argument (`session.projects.get(slug)` — the browser passes the
  // URL slug straight through, no client-side slug→id hop). <ItxProvider>
  // pre-warms the session in its own boundary so pages paint immediately; this
  // outer Suspense is only the safety net for pages that read through itx above
  // their own <ItxBoundary>. Keep page-level reads under smaller boundaries so
  // navigation never blanks the whole view.
  return (
    <Suspense fallback={<ItxResourceLoading label="project" />}>
      <ItxProvider>
        <ProjectScope slug={project.slug}>
          <Outlet />
        </ProjectScope>
      </ItxProvider>
    </Suspense>
  );
}
