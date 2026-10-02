// /global/<path> — the raw context explorer over the deployment-global namespace (the control
// plane's own: `/`, each person's `/users/<id>…`, each organization's `/organizations/<id>…`): its
// root is `api.global`, a platform admin's alone, and each context a `cd` from it (the wiring is
// packages/ui `use-context-explorer.ts`). The tree is every context that has announced itself to
// the global `/` (`itx/child-created`), live; the view is `ContextView`, as on a project's page.
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useIterateContext } from "iterate/react";
import { ContextView } from "@iterate-com/ui/components/context-view/context-view";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import { ContextPath } from "@iterate-com/ui/components/context-view/context-path";
import { ContextTree } from "@iterate-com/ui/components/context-view/context-tree";
import { contextPathOf, useContextExplorer } from "@iterate-com/ui/hooks/use-context-explorer";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/global/$")({
  validateSearch: ContextViewState,
  head: ({ params }) => ({
    meta: [{ title: `${contextPathOf(params._splat)} · Global · Admin` }],
  }),
  component: GlobalExplorer,
});

function GlobalExplorer() {
  const { api } = shell.useRouteContext();
  const { _splat } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const explorer = useContextExplorer({
    base: "/global",
    splat: _splat,
    openRoot: () => Promise.resolve(api.global),
    deps: [api],
  });
  const { path, links } = explorer;
  const announced = useIterateContext(explorer.rootStub, {
    consumes: ["events.iterate.com/itx/child-created"],
    history: "all",
  });
  const shown = useIterateContext(explorer.stub);
  const childPaths = announced.events.flatMap(({ payload }) =>
    typeof payload?.childPath === "string" ? [payload.childPath] : [],
  );
  return (
    <div className="flex min-h-0 flex-1">
      <ContextTree
        paths={[...new Set(childPaths)]}
        {...explorer.tree}
        className="w-60 shrink-0 border-r px-2 pt-1.5 pb-2"
      />
      <ContextView
        className="min-h-96 min-w-0 flex-1"
        title={<ContextPath path={path} links={links} />}
        pathLinks={links}
        context={shown}
        error={explorer.error}
        state={search}
        onStateChange={(patch) =>
          void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })
        }
      />
    </div>
  );
}
