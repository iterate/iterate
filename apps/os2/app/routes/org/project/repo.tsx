import { Suspense } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "../../../components/empty-state.tsx";
import { orpc } from "../../../lib/orpc.tsx";

export const Route = createFileRoute(
  "/_auth-required/_/orgs/$organizationSlug/_/projects/$projectSlug/repo",
)({
  component: ProjectRepoRoute,
});

function ProjectRepoRoute() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <ProjectRepoPage />
    </Suspense>
  );
}

type Project = {
  id: string;
  name: string;
  slug: string;
  repo?: { name: string; provider: string; owner: string; defaultBranch: string } | null;
};

function ProjectRepoPage() {
  const params = useParams({
    from: "/_auth-required.layout/_/orgs/$organizationSlug/_/projects/$projectSlug/repo",
  });
  const { data: project } = useSuspenseQuery(
    orpc.project.bySlug.queryOptions({
      input: {
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      },
    }),
  ) as { data: Project };

  const repo = project?.repo;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Repo</h1>
      <div className="mt-6">
        {repo ? (
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">Name</div>
            <div className="text-sm font-medium">{repo.name}</div>
            <div className="text-sm text-muted-foreground">Provider</div>
            <div className="text-sm font-medium capitalize">{repo.provider}</div>
            <div className="text-sm text-muted-foreground">Owner</div>
            <div className="text-sm font-medium">{repo.owner}</div>
            <div className="text-sm text-muted-foreground">Default Branch</div>
            <div className="text-sm font-medium">{repo.defaultBranch}</div>
          </div>
        ) : (
          <EmptyState
            icon={<GitBranch className="h-12 w-12" />}
            title="No repo connected"
            description="Connect a repository to sync code and branches."
            action={{
              label: "Connect repo",
              onClick: () => toast("Repo linking is coming soon."),
            }}
          />
        )}
      </div>
    </div>
  );
}
