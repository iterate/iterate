// /projects/<slug>/<path> — the raw context explorer over one project: every context the project's
// registry holds (the `project` facet's `contexts` on `/`, apps/os/src/project/contract.ts) as a
// list on the left, live, and the one the URL names on the right — `/projects/<slug>` is `/`,
// `…/agents/a` is `/agents/a`. The view is the general-purpose `ContextView` (packages/ui) over the
// SDK's `useIterateContext`; its filter, mode and inspected event are the URL's search, and its
// composer appends to the context shown, as the operator.
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { resolveContextPath } from "iterate/lib";
import { useContextStub, useFacetLiveState, useIterateContext } from "iterate/react";
import { ContextView } from "@iterate-com/ui/components/context-view/context-view";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import { Input } from "@iterate-com/ui/components/input";

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
  return (
    <div className="flex min-h-0 flex-1 gap-4 p-4">
      <ContextList slug={slug} paths={paths} current={path} />
      <ContextView
        className="min-h-96 min-w-0 flex-1"
        title={<span className="font-mono text-xs">{path}</span>}
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

/** Every context of the project, each a link, the one shown marked; a filter over the paths. */
function ContextList({ slug, paths, current }: { slug: string; paths: string[]; current: string }) {
  const [filter, setFilter] = useState("");
  const shown = paths.filter((path) => path.includes(filter.trim()));
  return (
    <nav aria-label="Contexts" className="flex w-64 shrink-0 flex-col gap-2">
      <Input
        aria-label="Filter contexts"
        placeholder={`${paths.length} contexts`}
        className="h-8 font-mono text-xs"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <ul className="min-h-0 flex-1 overflow-y-auto font-mono text-xs">
        {shown.map((path) => (
          <li key={path}>
            <Link
              to="/projects/$slug/$"
              params={{ slug, _splat: path.slice(1) }}
              aria-current={path === current ? "page" : undefined}
              className="block truncate rounded px-2 py-1 hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium"
            >
              {path}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The one field of the `project` facet's state this page reads: the context registry's paths. */
const Registry = z.looseObject({ contexts: z.record(z.string(), z.unknown()).optional() });
