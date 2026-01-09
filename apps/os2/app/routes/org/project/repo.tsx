import { Suspense, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Github, ChevronDown, Check, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../../components/ui/button.tsx";
import { EmptyState } from "../../../components/empty-state.tsx";
import { Card } from "../../../components/ui/card.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.tsx";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";

function useDisconnectGithub(params: { organizationSlug: string; projectSlug: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      trpcClient.project.disconnectGithub.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: () => {
      toast.success("GitHub disconnected");
      queryClient.invalidateQueries({
        queryKey: trpc.project.bySlug.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
      queryClient.invalidateQueries({
        queryKey: trpc.project.getGithubConnection.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
    },
    onError: (error) => {
      toast.error(`Failed to disconnect GitHub: ${error.message}`);
    },
  });
}

export const Route = createFileRoute(
  "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug/repo",
)({
  component: ProjectRepoRoute,
});

function ProjectRepoRoute() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <ProjectRepoPage />
    </Suspense>
  );
}

function ProjectRepoPage() {
  const params = useParams({
    from: "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug/repo",
  });
  const [isChangingRepo, setIsChangingRepo] = useState(false);

  const { data: project } = useSuspenseQuery(
    trpc.project.bySlug.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const { data: githubConnection } = useSuspenseQuery(
    trpc.project.getGithubConnection.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const repo = project?.projectRepo;

  const startGithubInstall = useMutation({
    mutationFn: () =>
      trpcClient.project.startGithubInstallFlow.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: (data) => {
      window.location.href = data.installationUrl;
    },
    onError: (error) => {
      toast.error(`Failed to start GitHub install: ${error.message}`);
    },
  });

  const disconnectGithub = useDisconnectGithub(params);

  if (repo && !isChangingRepo) {
    return (
      <div className="p-8 max-w-2xl">
        <h1 className="text-2xl font-bold">Repository</h1>
        <Card className="mt-6 p-6">
          <div className="flex items-start gap-4">
            <div className="rounded-md border bg-muted p-2">
              <Github className="h-6 w-6" />
            </div>
            <div className="flex-1 space-y-4">
              <div>
                <h2 className="text-lg font-semibold">
                  {repo.owner}/{repo.name}
                </h2>
                <p className="text-sm text-muted-foreground">
                  Branch: {repo.defaultBranch} · Provider: {repo.provider}
                </p>
              </div>
              <a
                href={`https://github.com/${repo.owner}/${repo.name}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                View on GitHub
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        </Card>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" onClick={() => setIsChangingRepo(true)}>
            Change repository
          </Button>
          <Button
            variant="outline"
            onClick={() => disconnectGithub.mutate()}
            disabled={disconnectGithub.isPending}
            className="text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
          >
            {disconnectGithub.isPending ? <Spinner className="mr-2" /> : null}
            Disconnect
          </Button>
        </div>
      </div>
    );
  }

  if (githubConnection.connected || isChangingRepo) {
    return (
      <div className="p-8 max-w-2xl">
        <h1 className="text-2xl font-bold">Repository</h1>
        <div className="mt-6">
          <Suspense fallback={<RepoPickerSkeleton />}>
            <RepoPicker
              params={params}
              currentRepo={repo}
              onCancel={repo ? () => setIsChangingRepo(false) : undefined}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Repository</h1>
      <div className="mt-6">
        <EmptyState
          icon={<GitBranch className="h-12 w-12" />}
          title="No repo connected"
          description="Connect your GitHub account to link a repository."
          action={
            <Button
              onClick={() => startGithubInstall.mutate()}
              disabled={startGithubInstall.isPending}
            >
              {startGithubInstall.isPending ? (
                <Spinner className="mr-2" />
              ) : (
                <Github className="mr-2 h-4 w-4" />
              )}
              Connect GitHub
            </Button>
          }
        />
      </div>
    </div>
  );
}

function RepoPickerSkeleton() {
  return (
    <Card className="p-6">
      <div className="flex items-center gap-2">
        <Spinner />
        <span className="text-sm text-muted-foreground">Loading repositories...</span>
      </div>
    </Card>
  );
}

function RepoPicker({
  params,
  currentRepo,
  onCancel,
}: {
  params: { organizationSlug: string; projectSlug: string };
  currentRepo?: { owner: string; name: string; defaultBranch: string } | null;
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedRepo, setSelectedRepo] = useState<{
    owner: string;
    name: string;
    defaultBranch: string;
  } | null>(currentRepo ?? null);

  const { data: reposData } = useSuspenseQuery(
    trpc.project.listAvailableGithubRepos.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const setProjectRepo = useMutation({
    mutationFn: (repo: { owner: string; name: string; defaultBranch: string }) =>
      trpcClient.project.setProjectRepo.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
      }),
    onSuccess: () => {
      toast.success("Repository connected successfully");
      queryClient.invalidateQueries({
        queryKey: trpc.project.bySlug.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
      onCancel?.();
    },
    onError: (error) => {
      toast.error(`Failed to set repository: ${error.message}`);
    },
  });

  const updateGithubPermissions = useMutation({
    mutationFn: () =>
      trpcClient.project.startGithubInstallFlow.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: (data) => {
      window.location.href = data.installationUrl;
    },
    onError: (error) => {
      toast.error(`Failed to update GitHub permissions: ${error.message}`);
    },
  });

  const repositories = reposData.repositories;

  if (repositories.length === 0) {
    return (
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">
          No repositories found. Make sure you have granted access to at least one repository during
          GitHub App installation.
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => updateGithubPermissions.mutate()}
          disabled={updateGithubPermissions.isPending}
        >
          {updateGithubPermissions.isPending ? <Spinner className="mr-2" /> : null}
          Update GitHub permissions
        </Button>
      </Card>
    );
  }

  const hasChanged =
    selectedRepo &&
    currentRepo &&
    (selectedRepo.owner !== currentRepo.owner ||
      selectedRepo.name !== currentRepo.name ||
      selectedRepo.defaultBranch !== currentRepo.defaultBranch);

  return (
    <Card className="p-6">
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">Select a repository</h2>
          <p className="text-sm text-muted-foreground">
            Choose which repository to connect to this project.
          </p>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-full justify-between">
              {selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : "Select repository..."}
              <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)] max-h-[300px] overflow-y-auto">
            {repositories.map((repo) => (
              <DropdownMenuItem
                key={repo.id}
                onClick={() =>
                  setSelectedRepo({
                    owner: repo.owner,
                    name: repo.name,
                    defaultBranch: repo.defaultBranch,
                  })
                }
              >
                <span className="flex-1">{repo.fullName}</span>
                {selectedRepo?.owner === repo.owner && selectedRepo?.name === repo.name && (
                  <Check className="h-4 w-4" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex gap-2">
          <Button
            onClick={() => selectedRepo && setProjectRepo.mutate(selectedRepo)}
            disabled={!selectedRepo || setProjectRepo.isPending || (!!currentRepo && !hasChanged)}
          >
            {setProjectRepo.isPending ? <Spinner className="mr-2" /> : null}
            {currentRepo ? "Save" : "Connect repository"}
          </Button>
          {onCancel && (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
