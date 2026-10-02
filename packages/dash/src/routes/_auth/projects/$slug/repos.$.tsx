// /projects/<slug>/repos/<name> — one repo of the project as a small IDE: the file tree, an
// editable CodeMirror buffer with a diff against the last commit, source control (stage, commit),
// and the repo's history (packages/ui `RepoIde`). The path is the URL's own tail: `…/repos/config`
// is the repo `/repos/config`. The IDE's every choice — open file, diff, preview, sidebar — is the
// URL's search, so every state is a link. Full width, and the IDE fills what the shell leaves it.
// The project stays open as a held stub while the page is up: the IDE follows the repo's commits
// live, so it is a hook (`useContextStub`), not a loader. The route's component is its own chunk
// (Start's automatic code splitting), CodeMirror a further one the editor loads when it mounts.
import { createFileRoute } from "@tanstack/react-router";
import { useContextStub } from "iterate/react";
import { RepoIde } from "@iterate-com/ui/components/repo-ide/repo-ide";
import { RepoIdeSearch } from "@iterate-com/ui/components/repo-ide/repo-ide-search";

export const Route = createFileRoute("/_auth/projects/$slug/repos/$")({
  validateSearch: RepoIdeSearch,
  staticData: { page: "Repos" },
  head: ({ params }) => ({
    meta: [{ title: `${params._splat} · Repos · ${params.slug} · Dash` }],
  }),
  component: ProjectRepo,
});

function ProjectRepo() {
  const { api, info, project } = Route.useRouteContext();
  const { _splat } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const context = useContextStub(() => api.projects.get(project.id), [api, project.id]);
  const email = info.principal.email;
  if (context.error) {
    return (
      <p role="alert" data-type="error" className="p-4 text-sm text-destructive">
        {context.error}
      </p>
    );
  }
  if (!context.stub) {
    return (
      <div
        className="grid flex-1 place-items-center text-sm text-muted-foreground"
        data-spinner="true"
      >
        Opening the project…
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1">
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
    </div>
  );
}
