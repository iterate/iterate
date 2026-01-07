import { Suspense } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "../../../components/empty-state.tsx";
import { trpc } from "../../../lib/trpc.ts";

export const Route = createFileRoute(
  "/_auth-required.layout/_/orgs/$organizationSlug/_/projects/$projectSlug/repo",
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

function ProjectRepoPage() {
  const params = useParams({
    from: "/_auth-required.layout/_/orgs/$organizationSlug/_/projects/$projectSlug/repo",
  });
  const { data: project } = useSuspenseQuery(
    trpc.instance.bySlug.queryOptions({
      organizationSlug: params.organizationSlug,
      instanceSlug: params.projectSlug,
    }),
  );

  const repo = project?.repos?.[0];

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Repo</h1>
      <div className="mt-6">
        {repo ? (
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">Provider</div>
            <div className="text-sm font-medium capitalize">{repo.provider}</div>
            <div className="text-sm text-muted-foreground">Account</div>
            <div className="text-sm font-medium">{repo.accountId}</div>
            <div className="text-sm text-muted-foreground">Repository ID</div>
            <div className="text-sm font-medium">{repo.repoId}</div>
            <div className="text-sm text-muted-foreground">Branch</div>
            <div className="text-sm font-medium">{repo.branch}</div>
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
