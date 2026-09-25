// /projects/<slug>/contexts/<path> — any context of the project, live: its log, its processors,
// who is here and every hosted processor's live state (components/context-activity.tsx, the view
// /activity and an organization's activity page use), over `project.cd(path)`. The path is the
// URL's own tail — `/projects/<slug>/contexts` is the root `/`, `…/contexts/repos/config` is
// `/repos/config` — and the view's filter, inspected event and open sheet are its search, so every
// state is a link. Above the view: the path, each segment a link up; a box to go to any path; and
// every context under this one — the project's context registry (the `project` facet's `contexts`
// on `/`, apps/os/src/project/contract.ts), so on `/` the list is every context of the project —
// each a link down. Replaces the old platform's `/projects/<slug>/streams/$` explorer (removed with
// it in #2837).
import { useState } from "react";
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router";
import { z } from "zod";
import { resolveContextPath } from "iterate/lib";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import { Input } from "@iterate-com/ui/components/input";
import { useContextStub, useFacetLiveState } from "iterate/react";
import { ContextActivity } from "../../../../components/context-activity.tsx";

const shell = getRouteApi("/_auth");
const projectRoute = getRouteApi("/_auth/projects/$slug");

export const Route = createFileRoute("/_auth/projects/$slug/contexts/$")({
  // the view's every choice — mode, filter, the inspected event, the open sheet — is this URL
  validateSearch: ContextViewState,
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
  const path = contextPathOf(_splat);
  // the project's root, held for the page's life: the catalogs below read its live state, and every
  // path is a `cd` from it; the context shown is released and re-opened when the path changes
  const root = useContextStub(() => api.projects.get(project.id), [api, project.id]);
  const rootStub = root.stub;
  const context = useContextStub(rootStub ? () => rootStub.cd(path) : null, [rootStub, path]);
  const error = root.error || context.error;
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Contexts</h1>
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
              to: "/projects/$slug/contexts/$",
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
        <Link to="/projects/$slug/contexts/$" params={{ slug, _splat: "" }} className={link}>
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
                to="/projects/$slug/contexts/$"
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

/** Every context the project's registry holds under `path`, each a link, with a filter once the
 *  list is long. Pushed, not read: the registry is the `project` facet's live state on `/`, so a
 *  context born while the page is open shows up. */
function ChildContexts({
  slug,
  path,
  root,
}: {
  slug: string;
  path: string;
  root: Parameters<typeof useFacetLiveState>[0];
}) {
  const [filter, setFilter] = useState("");
  const registry = Registry.safeParse(useFacetLiveState(root, "project").value).data;
  const prefix = path === "/" ? "/" : `${path}/`;
  const children = Object.keys(registry?.contexts ?? {})
    .filter((candidate) => candidate.startsWith(prefix))
    .sort();
  if (!children.length) return null;
  const shown = children.filter((child) => child.includes(filter.trim()));
  return (
    <section aria-label="Contexts under this path" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium text-muted-foreground">
          {children.length} under {path}
        </h2>
        {children.length > 12 ? (
          <Input
            aria-label="Filter contexts"
            placeholder="Filter"
            className="h-7 w-48 font-mono text-xs"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        ) : null}
      </div>
      <ul className="flex max-h-48 flex-wrap gap-x-4 gap-y-1 overflow-y-auto font-mono text-sm">
        {shown.map((child) => (
          <li key={child}>
            <Link
              to="/projects/$slug/contexts/$"
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

/** The one field of the `project` facet's state this page reads: the context registry's paths, as
 *  keys (apps/os/src/project/contract.ts `contexts`). */
const Registry = z.looseObject({ contexts: z.record(z.string(), z.unknown()).optional() });

/** The URL's tail as a context path, canonical as `cd` reads it (`resolveContextPath`, the SDK's
 *  one resolver): `` → `/`, `repos/config/` → `/repos/config`. */
function contextPathOf(splat: string | undefined) {
  return resolveContextPath("/", splat || "");
}

/** A context path as the URL's tail: `/` → ``, `/repos/config` → `repos/config`. */
function splatOf(path: string) {
  return path.slice(1);
}
