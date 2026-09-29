import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useMemo, useSyncExternalStore } from "react";
import { ProjectAppShell } from "@iterate-com/ui/components/project-app-shell";
import { DocsNav } from "../../components/docs-nav.tsx";
import { DocList, DocListContext } from "../../lib/doc-list.ts";
import { repoNames, repoPath } from "../../lib/docs-repo.ts";

/** A project's docs, framed in the shell every OS app shares: in its sidebar, a picker of the
 *  project's repos and the picked repo's docs as a tree. */
export const Route = createFileRoute("/_auth/projects/$slug")({
  beforeLoad: async ({ context, params }) => {
    const projects = await context.api.projects.list();
    // the URL names the project by slug; one this sign-in lacks → sign in again
    const project = projects.find((item) => item.slug === params.slug);
    if (!project) return context.signInFor(params.slug);
    return { projects, project };
  },
  component: ProjectDocs,
});

function ProjectDocs() {
  const { projects, project, info, basePath, api } = Route.useRouteContext();
  const { slug } = Route.useParams();
  // the repo the page is in (its child routes' `$repo`); config on the way to it
  const { repo: pageRepo, _splat: openPath } = useParams({ strict: false });
  const repo = pageRepo || "config";
  const navigate = useNavigate();
  const href = useRouterState({ select: (state) => state.location.href });
  // one list per repo: the sidebar's tree and the doc list read the same one
  const docList = useMemo(
    () => new DocList(() => api.projects.get(project.id), repoPath(repo)),
    [api, project.id, repo],
  );
  // ⌘K finds a file by name: the tree draws in its own shadow DOM, where the palette can't read it
  const listed = useSyncExternalStore(docList.subscribe, docList.state, docList.state);
  const paletteEntries = useMemo(
    () =>
      listed.kind === "loaded"
        ? listed.paths.map((path) => ({
            label: path.split("/").at(-1)!,
            group: "Files",
            detail: path.includes("/") ? path.split("/").slice(0, -1).join("/") : repo,
            active: path === openPath,
            onSelect: () =>
              void navigate({
                to: "/projects/$slug/$repo/$",
                params: { slug, repo, _splat: path },
              }),
          }))
        : [],
    [listed, openPath, navigate, slug, repo],
  );
  const repos = useQuery({
    queryKey: ["repos", project.id],
    queryFn: async () => {
      using itx = await api.projects.get(project.id);
      return repoNames(await itx.repos.list());
    },
  });
  return (
    <DocListContext value={docList}>
      <ProjectAppShell
        app="Docs"
        projects={projects}
        project={project}
        basePath={basePath}
        account={info.principal}
        locationKey={href}
        nav={<DocsNav slug={slug} repo={repo} repos={repos.data} />}
        paletteEntries={paletteEntries}
      >
        <Outlet />
      </ProjectAppShell>
    </DocListContext>
  );
}
