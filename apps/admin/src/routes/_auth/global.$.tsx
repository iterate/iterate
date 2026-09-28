// /global/<path> — the raw context explorer over the deployment-global namespace (the control
// plane's own: `/`, each person's `/users/<id>…`, each organization's `/organizations/<id>…`): its
// root is `api.global`, a platform admin's alone, and each context a `cd` from it. The tree (packages/ui `context-tree.tsx`) is every context that has
// announced itself to the global `/` (`itx/child-created`), live; the view is `ContextView`, as on a
// project's page.
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { resolveContextPath } from "iterate/lib";
import { useContextStub, useIterateContext } from "iterate/react";
import { ContextView } from "@iterate-com/ui/components/context-view/context-view";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import {
  ContextPath,
  type ContextPathLinks,
} from "@iterate-com/ui/components/context-view/context-path";
import { ContextTree } from "@iterate-com/ui/components/context-view/context-tree";

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
  const router = useRouter();
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
  const links = useMemo(
    (): ContextPathLinks => ({
      hrefOf: (to) => `/global${to === "/" ? "" : to.split("/").map(encodeURIComponent).join("/")}`,
      // a path opens afresh: the view's search (filter, inspected event) was the last path's
      onNavigate: (href, event) => {
        event.preventDefault();
        void router.navigate({ href });
      },
    }),
    [router],
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
