// /projects/<slug>/repos/<name> — one repo of the project as a small IDE: the file tree, an
// editable CodeMirror buffer with a diff against the last commit, source control (stage, commit),
// and the repo's history (components/repo-ide). The path is the URL's own tail: `…/repos/config`
// is the repo `/repos/config`. The IDE's every choice — open file, diff, preview, sidebar — is the
// URL's search, so every state is a link. Full width, and the IDE fills what the shell leaves it.
import { lazy, Suspense } from "react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useContextStub } from "iterate/react";
import { RepoIdeSearch } from "@iterate-com/ui/components/repo-ide/repo-ide-search";

const RepoIde = lazy(async () => ({
  default: (await import("@iterate-com/ui/components/repo-ide/repo-ide")).RepoIde,
}));

const shell = getRouteApi("/_auth");
const projectRoute = getRouteApi("/_auth/projects/$slug");

export const Route = createFileRoute("/_auth/projects/$slug/repos/$")({
  validateSearch: RepoIdeSearch,
  staticData: { page: "Repos" },
  head: ({ params }) => ({
    meta: [{ title: `${params._splat} · Repos · ${params.slug} · Dash` }],
  }),
  component: ProjectRepo,
});

function ProjectRepo() {
  const { api, info } = shell.useRouteContext();
  const { project } = projectRoute.useRouteContext();
  const { _splat } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const context = useContextStub(() => api.projects.get(project.id), [api, project.id]);
  const email = info.principal.email;
  return (
    <div className="flex min-h-0 flex-1">
      {context.error ? (
        <p role="alert" data-type="error" className="p-4 text-sm text-destructive">
          {context.error}
        </p>
      ) : context.stub ? (
        <Suspense
          fallback={
            <div
              className="grid flex-1 place-items-center text-sm text-muted-foreground"
              data-spinner="true"
            >
              Loading the editor…
            </div>
          }
        >
          <RepoIde
            // one IDE per repo: its working tree and open file are that repo's
            key={`${project.id}:${_splat}`}
            project={context.stub}
            projectId={project.id}
            repoPath={`/repos/${_splat}`}
            author={email ? { name: email, email } : undefined}
            search={search}
            onSearchChange={(patch) =>
              void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })
            }
          />
        </Suspense>
      ) : (
        <div
          className="grid flex-1 place-items-center text-sm text-muted-foreground"
          data-spinner="true"
        >
          Opening the project…
        </div>
      )}
    </div>
  );
}
