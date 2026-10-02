// /projects/<slug>/<path> — the raw context explorer over one project: every context the project's
// registry holds as a tree on the left, live, and the one the URL names on the right —
// `/projects/<slug>` is `/`, `…/agents/a` is `/agents/a` (the wiring is packages/ui
// `use-context-explorer.ts`). The view is the general-purpose `ContextView` (packages/ui) over the
// SDK's `useIterateContext`; its filter, mode and inspected event are the URL's search, and its
// composer appends to the context shown, as the operator.
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useIterateContext } from "iterate/react";
import { ContextView } from "@iterate-com/ui/components/context-view/context-view";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import { ContextPath } from "@iterate-com/ui/components/context-view/context-path";
import { ContextTree } from "@iterate-com/ui/components/context-view/context-tree";
import {
  contextPathOf,
  useContextExplorer,
  useRegistryPaths,
} from "@iterate-com/ui/hooks/use-context-explorer";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/projects/$slug/$")({
  validateSearch: ContextViewState,
  head: ({ params }) => ({
    meta: [{ title: `${contextPathOf(params._splat)} · ${params.slug} · Admin` }],
  }),
  component: ProjectExplorer,
});

function ProjectExplorer() {
  const { api } = shell.useRouteContext();
  const { projects } = shell.useLoaderData();
  const { slug, _splat } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const project = projects.find((candidate) => candidate.slug === slug);
  const explorer = useContextExplorer({
    base: `/projects/${encodeURIComponent(slug)}`,
    splat: _splat,
    openRoot: project ? () => api.projects.get(project.id) : null,
    deps: [api, project?.id],
  });
  const { path, links, stub } = explorer;
  const iterateContext = useIterateContext(stub);
  const paths = useRegistryPaths(explorer.rootStub);
  return (
    <div className="flex min-h-0 flex-1">
      <ContextTree
        paths={paths}
        {...explorer.tree}
        className="w-60 shrink-0 border-r px-2 pt-1.5 pb-2"
      />
      <ContextView
        className="min-h-96 min-w-0 flex-1"
        title={<ContextPath path={path} links={links} />}
        pathLinks={links}
        context={iterateContext}
        error={project ? explorer.error : `No project ${slug}`}
        state={search}
        onStateChange={(patch) =>
          void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })
        }
        onAppend={stub ? (events) => stub.append(...events) : undefined}
      />
    </div>
  );
}
