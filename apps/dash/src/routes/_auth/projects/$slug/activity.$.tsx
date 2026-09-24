// /projects/<slug>/activity/<path> — any context of the project, live: its log, its processors,
// who is here and every hosted processor's live state (components/context-activity.tsx, the view
// /activity and an organization's activity page use), over `project.cd(path)`. The path is the
// URL's own tail — `/projects/<slug>/activity` is the root `/`, `…/activity/repos/config` is
// `/repos/config` — and the view's filter, inspected event and open sheet are its search, so every
// state is a link. Above the view: the path, each segment a link up; a box to go to any path; and
// the contexts the project's catalogs know under this one — its repos and workspaces (the
// `project` facet's live state on `/`) and its agents (the agents app's `agents` facet, when
// installed) — each a link down. Replaces the old platform's `/projects/<slug>/streams/$` explorer
// (removed with it in #2837).
import { useState } from "react";
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router";
import { z } from "zod";
import { resolveContextPath } from "iterate/next/lib";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import { Input } from "@iterate-com/ui/components/input";
import { ContextActivity } from "../../../../components/context-activity.tsx";
import { useContextStub, useFacetLiveState } from "../../../../lib/context-stub.ts";

const shell = getRouteApi("/_auth");
const projectRoute = getRouteApi("/_auth/projects/$slug");

export const Route = createFileRoute("/_auth/projects/$slug/activity/$")({
  // the view's every choice — mode, filter, the inspected event, the open sheet — is this URL
  validateSearch: ContextViewState,
  head: ({ params }) => ({
    meta: [{ title: `${contextPathOf(params._splat)} · Activity · ${params.slug} · Dash` }],
  }),
  component: ProjectActivity,
});

function ProjectActivity() {
  const { api } = shell.useRouteContext();
  const { project } = projectRoute.useRouteContext();
  const { _splat } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const path = contextPathOf(_splat);
  // the project's root, held for the page's life: the catalogs below read its live state, and every
  // path is a `cd` from it; the context shown is released and re-opened when the path changes
  const root = useContextStub(() => api.projects.get(project.id), [api, project.id]);
  const rootStub = root.stub;
  const context = useContextStub(rootStub ? () => rootStub.cd(path) : null, [rootStub, path]);
  const error = root.error || context.error;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-muted-foreground">
          Any context of this project, live: its log, its processors and what they hold.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ContextPathLinks slug={project.slug} path={path} />
        <GoToPath
          key={path}
          path={path}
          onGo={(next) =>
            void navigate({
              to: "/projects/$slug/activity/$",
              params: { slug: project.slug, _splat: splatOf(next) },
              search: {},
            })
          }
        />
      </div>
      <ChildContexts slug={project.slug} path={path} root={rootStub} />
      {error ? (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <ContextActivity
          state={search}
          onStateChange={(patch) =>
            void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })
          }
          itx={context.stub}
          title={<span className="font-mono text-xs">{path}</span>}
        />
      )}
    </div>
  );
}

/** The path, `/` first, each segment a link to the context it names — the way back up. */
function ContextPathLinks({ slug, path }: { slug: string; path: string }) {
  const segments = path.split("/").filter(Boolean);
  const link = "text-muted-foreground hover:text-foreground hover:underline";
  return (
    <nav aria-label="Context path" className="flex flex-wrap items-center font-mono text-sm">
      {path === "/" ? (
        <span aria-current="page">/</span>
      ) : (
        <Link to="/projects/$slug/activity/$" params={{ slug, _splat: "" }} className={link}>
          /
        </Link>
      )}
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        return (
          <span key={index} className="flex items-center">
            {index ? <span className="text-muted-foreground">/</span> : null}
            {last ? (
              <span aria-current="page">{segment}</span>
            ) : (
              <Link
                to="/projects/$slug/activity/$"
                params={{ slug, _splat: segments.slice(0, index + 1).join("/") }}
                className={link}
              >
                {segment}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** A path typed in — relative to the one shown (`..`, `sandbox`) or absolute (`/agents/a`). */
function GoToPath({ path, onGo }: { path: string; onGo: (path: string) => void }) {
  const [draft, setDraft] = useState(path);
  return (
    <form
      className="w-full sm:w-72"
      onSubmit={(event) => {
        event.preventDefault();
        onGo(resolveContextPath(path, draft));
      }}
    >
      <Input
        aria-label="Go to path"
        placeholder="/repos/config"
        className="font-mono"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </form>
  );
}

/** The contexts the project's catalogs hold under `path`, each a link. Pushed, not read: the
 *  catalogs are facets' live state on `/`, so a repo, workspace or agent born while the page is open
 *  shows up. A project without the agents app answers no `agents` facet — no agents, no error. */
function ChildContexts({
  slug,
  path,
  root,
}: {
  slug: string;
  path: string;
  root: Parameters<typeof useFacetLiveState>[0];
}) {
  const projectCatalog = Catalog.safeParse(useFacetLiveState(root, "project").value).data;
  const agentsCatalog = Catalog.safeParse(useFacetLiveState(root, "agents").value).data;
  const prefix = path === "/" ? "/" : `${path}/`;
  const children = [
    ...Object.keys(projectCatalog?.repos ?? {}),
    ...Object.keys(projectCatalog?.workspaces ?? {}),
    ...Object.keys(agentsCatalog?.agents ?? {}),
  ]
    .filter((candidate) => candidate.startsWith(prefix) && candidate !== path)
    .sort();
  if (!children.length) return null;
  return (
    <section aria-label="Contexts under this path" className="flex flex-col gap-1">
      <h2 className="text-xs font-medium text-muted-foreground">Under {path}</h2>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm">
        {children.map((child) => (
          <li key={child}>
            <Link
              to="/projects/$slug/activity/$"
              params={{ slug, _splat: splatOf(child) }}
              className="hover:underline"
            >
              {child.slice(prefix.length)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The one field of each catalog this page reads: the paths it knows, as keys (the `project`
 *  facet's `repos`/`workspaces`, apps/os/src/project/contract.ts; the `agents` facet's `agents`,
 *  apps/agents/runtime/catalog.ts). */
const Catalog = z.looseObject({
  repos: z.record(z.string(), z.unknown()).optional(),
  workspaces: z.record(z.string(), z.unknown()).optional(),
  agents: z.record(z.string(), z.unknown()).optional(),
});

/** The URL's tail as a context path, canonical as `cd` reads it (`resolveContextPath`, the SDK's
 *  one resolver): `` → `/`, `repos/config/` → `/repos/config`. */
function contextPathOf(splat: string | undefined) {
  return resolveContextPath("/", splat || "");
}

/** A context path as the URL's tail: `/` → ``, `/repos/config` → `repos/config`. */
function splatOf(path: string) {
  return path.slice(1);
}
