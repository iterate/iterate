// /projects/<slug>/contexts/<path> — any context of the project, live: its log, its processors,
// who is here and every hosted processor's live state (components/context-activity.tsx, the view
// /activity and an organization's activity page use), over `project.cd(path)`. The path is the
// URL's own tail — `/projects/<slug>/contexts` is the root `/`, `…/contexts/repos/config` is
// `/repos/config` — and the view's filter, inspected event and open sheet are its search, so every
// state is a link. Full width, two panes: on the left the context tree (packages/ui
// `context-tree.tsx`) over the project's context registry (the `project` facet's `contexts` on `/`,
// apps/os/src/project/contract.ts), live; on the right the context, its path once on the view's
// strip. A phone has the tree in a sheet, opened from the path. The shell's breadcrumb ends in
// "Contexts". Replaces the old platform's `/projects/<slug>/streams/$` explorer (removed with it
// in #2837).
import { useMemo } from "react";
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { resolveContextPath } from "iterate/lib";
import {
  ContextPath,
  type ContextPathLinks,
} from "@iterate-com/ui/components/context-view/context-path";
import {
  ContextTree,
  ContextTreeSheet,
} from "@iterate-com/ui/components/context-view/context-tree";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import { useContextStub, useFacetLiveState } from "iterate/react";
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
  const router = useRouter();
  const path = contextPathOf(_splat);
  // the project's root, held for the page's life: the registry is its live state, and every path
  // is a `cd` from it; the context shown is released and re-opened when the path changes
  const root = useContextStub(() => api.projects.get(project.id), [api, project.id]);
  const rootStub = root.stub;
  const context = useContextStub(rootStub ? () => rootStub.cd(path) : null, [rootStub, path]);
  const error = root.error || context.error;
  const registry = Registry.safeParse(useFacetLiveState(rootStub, "project").value).data;
  const contexts = registry?.contexts;
  const paths = useMemo(() => Object.keys(contexts || {}), [contexts]);
  const links = useMemo(
    (): ContextPathLinks => ({
      hrefOf: (to) =>
        `/projects/${encodeURIComponent(project.slug)}/contexts${to === "/" ? "" : to.split("/").map(encodeURIComponent).join("/")}`,
      // a path opens afresh: the view's search (filter, inspected event) was the last path's
      onNavigate: (href, event) => {
        event.preventDefault();
        void router.navigate({ href });
      },
    }),
    [project.slug, router],
  );
  const tree = {
    paths,
    current: path,
    links,
    resolvePath: (typed: string) => resolveContextPath(path, typed),
  };
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
            itx={context.stub}
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

/** The one field of the `project` facet's state this page reads: the context registry's paths, as
 *  keys (apps/os/src/project/contract.ts `contexts`). */
const Registry = z.looseObject({ contexts: z.record(z.string(), z.unknown()).optional() });

/** The URL's tail as a context path, canonical as `cd` reads it (`resolveContextPath`, the SDK's
 *  one resolver): `` → `/`, `repos/config/` → `/repos/config`. */
function contextPathOf(splat: string | undefined) {
  return resolveContextPath("/", splat || "");
}
