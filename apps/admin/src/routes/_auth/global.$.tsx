// /global/<path> — the raw context explorer over the deployment-global namespace (the control
// plane's own: `/`, each person's `/users/<id>…`, each organization's `/organizations/<id>…`): its
// root is `api.global`, a platform admin's alone, and each context a `cd` from it. The list is every context that has
// announced itself to the global `/` (`itx/child-created`), live; the view is `ContextView`, as on a
// project's page.
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import { resolveContextPath } from "iterate/lib";
import { useContextStub, useIterateContext } from "iterate/react";
import { ContextView } from "@iterate-com/ui/components/context-view/context-view";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import { Input } from "@iterate-com/ui/components/input";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/global/$")({
  validateSearch: ContextViewState,
  head: ({ params }) => ({
    meta: [{ title: `${resolveContextPath("/", params._splat || "")} · Global · Admin` }],
  }),
  component: GlobalExplorer,
});

function GlobalExplorer() {
  const { api } = shell.useRouteContext();
  const { _splat } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const path = resolveContextPath("/", _splat || "");
  // the root is held for the page's life (its log lists the contexts); the context shown is a `cd`
  // from it, released and re-opened as the path changes
  const root = useContextStub(() => Promise.resolve(api.global), [api]);
  const rootStub = root.stub;
  const context = useContextStub(rootStub ? () => rootStub.cd(path) : null, [rootStub, path]);
  const announced = useIterateContext(rootStub, {
    consumes: ["events.iterate.com/itx/child-created"],
    history: "all",
  });
  const shown = useIterateContext(context.stub);
  const childPaths = announced.events.flatMap(({ payload }) =>
    typeof payload?.childPath === "string" ? [payload.childPath] : [],
  );
  const paths = ["/", ...new Set(childPaths)].sort();
  return (
    <div className="flex min-h-0 flex-1 gap-4 p-4">
      <ContextList paths={paths} current={path} />
      <ContextView
        className="min-h-96 min-w-0 flex-1"
        title={<span className="font-mono text-xs">{path}</span>}
        context={shown}
        error={root.error || context.error}
        state={search}
        onStateChange={(patch) =>
          void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })
        }
      />
    </div>
  );
}

/** Every global context, each a link, the one shown marked; a filter over the paths. */
function ContextList({ paths, current }: { paths: string[]; current: string }) {
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
              to="/global/$"
              params={{ _splat: path.slice(1) }}
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
