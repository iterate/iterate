// /projects/<slug>/<path> — the raw context explorer over one project: every context the project's
// registry holds (the `project` facet's `contexts` on `/`, apps/os/src/project/contract.ts) as a
// tree on the left (packages/ui `context-tree.tsx`), live, and the one the URL names on the right — `/projects/<slug>` is `/`,
// `…/agents/a` is `/agents/a`. The view is the general-purpose `ContextView` (packages/ui) over the
// SDK's `useIterateContext`; its filter, mode and inspected event are the URL's search, and its
// composer appends to the context shown, as the operator.
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";
import { resolveContextPath } from "iterate/lib";
import { useContextStub, useFacetLiveState, useIterateContext } from "iterate/react";
import { ContextView } from "@iterate-com/ui/components/context-view/context-view";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import {
  ContextPath,
  type ContextPathLinks,
} from "@iterate-com/ui/components/context-view/context-path";
import { ContextTree } from "@iterate-com/ui/components/context-view/context-tree";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/projects/$slug/$")({
  validateSearch: ContextViewState,
  head: ({ params }) => ({
    meta: [{ title: `${resolveContextPath("/", params._splat || "")} · ${params.slug} · Admin` }],
  }),
  component: ProjectExplorer,
});

function ProjectExplorer() {
  const { api } = shell.useRouteContext();
  const { projects } = shell.useLoaderData();
  const { slug, _splat } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const path = resolveContextPath("/", _splat || "");
  const project = projects.find((candidate) => candidate.slug === slug);
  // the root is held for the page's life (the registry is its live state); the context shown is
  // a `cd` from it, released and re-opened as the path changes
  const root = useContextStub(project ? () => api.projects.get(project.id) : null, [
    api,
    project?.id,
  ]);
  const rootStub = root.stub;
  const context = useContextStub(rootStub ? () => rootStub.cd(path) : null, [rootStub, path]);
  const stub = context.stub;
  const iterateContext = useIterateContext(stub);
  const registry = Registry.safeParse(useFacetLiveState(rootStub, "project").value).data;
  const paths = ["/", ...Object.keys(registry?.contexts ?? {}).sort()];
  const links = useMemo(
    (): ContextPathLinks => ({
      hrefOf: (to) =>
        `/projects/${encodeURIComponent(slug)}${to === "/" ? "" : to.split("/").map(encodeURIComponent).join("/")}`,
      // a path opens afresh: the view's search (filter, inspected event) was the last path's
      onNavigate: (href, event) => {
        event.preventDefault();
        void router.navigate({ href });
      },
    }),
    [slug, router],
  );
  return (
    <div className="flex min-h-0 flex-1">
      <ContextTree
        paths={paths}
        current={path}
        links={links}
        resolvePath={(typed) => resolveContextPath(path, typed)}
        className="w-60 shrink-0 border-r px-2 pt-1.5 pb-2"
      />
      <ContextView
        className="min-h-96 min-w-0 flex-1"
        title={<ContextPath path={path} links={links} />}
        pathLinks={links}
        context={iterateContext}
        error={project ? root.error || context.error : `No project ${slug}`}
        state={search}
        onStateChange={(patch) =>
          void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })
        }
        onAppend={stub ? (events) => stub.append(...events) : undefined}
      />
    </div>
  );
}

/** The one field of the `project` facet's state this page reads: the context registry's paths. */
const Registry = z.looseObject({ contexts: z.record(z.string(), z.unknown()).optional() });
