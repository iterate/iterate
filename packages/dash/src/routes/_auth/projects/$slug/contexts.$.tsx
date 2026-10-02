// /projects/<slug>/contexts/<path> — any context of the project, live: its log, its processors,
// who is here and every hosted processor's live state (components/context-activity.tsx, the view
// /activity and an organization's activity page use), over `project.cd(path)`. The path is the
// URL's own tail — `/projects/<slug>/contexts` is the root `/`, `…/contexts/repos/config` is
// `/repos/config` — and the view's filter, inspected event and open sheet are its search, so every
// state is a link. Full width, two panes: on the left the context tree over the project's context
// registry, live; on the right the context, its path once on the view's strip (the wiring is
// packages/ui `use-context-explorer.ts`). A phone has the tree in a sheet, opened from the path.
// The shell's breadcrumb ends in "Contexts".
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { ContextPath } from "@iterate-com/ui/components/context-view/context-path";
import {
  ContextTree,
  ContextTreeSheet,
} from "@iterate-com/ui/components/context-view/context-tree";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import {
  contextPathOf,
  useContextExplorer,
  useRegistryPaths,
} from "@iterate-com/ui/hooks/use-context-explorer";
import { ContextActivity } from "../../../../components/context-activity.tsx";

const shell = getRouteApi("/_auth");
const projectRoute = getRouteApi("/_auth/projects/$slug");

export const Route = createFileRoute("/_auth/projects/$slug/contexts/$")({
  // the view's every choice — mode, filter, the inspected event, the open sheet — is this URL
  validateSearch: ContextViewState,
  staticData: { page: "Contexts" },
  head: ({ params }) => ({
    meta: [{ title: `${contextPathOf(params._splat)} · Contexts · ${params.slug} · Dash` }],
  }),
  component: ProjectContexts,
});

function ProjectContexts() {
  const { api } = shell.useRouteContext();
  const { project } = projectRoute.useRouteContext();
  const { _splat } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const explorer = useContextExplorer({
    base: `/projects/${encodeURIComponent(project.slug)}/contexts`,
    splat: _splat,
    openRoot: () => api.projects.get(project.id),
    deps: [api, project.id],
  });
  const { path, links, error } = explorer;
  const tree = { paths: useRegistryPaths(explorer.rootStub), ...explorer.tree };
  return (
    <div className="flex min-h-0 flex-1">
      <ContextTree {...tree} className="hidden w-60 shrink-0 border-r px-2 pt-1.5 pb-2 lg:flex" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {error ? (
          <>
            {/* the path and, on a phone, the tree stay: the way out of a path that failed */}
            <div className="flex items-center px-3 py-1.5 sm:px-4">
              <ContextTreeSheet {...tree} className="lg:hidden" />
              <ContextPath path={path} links={links} className="max-lg:hidden" />
            </div>
            <p
              role="alert"
              data-type="error"
              className="px-3 py-2 text-sm text-destructive sm:px-4"
            >
              {error}
            </p>
          </>
        ) : (
          <ContextActivity
            state={search}
            onStateChange={(patch) =>
              void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })
            }
            itx={explorer.stub}
            pathLinks={links}
            title={
              <>
                <ContextTreeSheet {...tree} className="lg:hidden" />
                <ContextPath path={path} links={links} className="max-lg:hidden" />
              </>
            }
          />
        )}
      </div>
    </div>
  );
}
