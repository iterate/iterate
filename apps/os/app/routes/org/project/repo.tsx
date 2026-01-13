import { Suspense, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Github, ChevronDown, Check, ExternalLink, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../../components/ui/button.tsx";
import { EmptyState } from "../../../components/empty-state.tsx";
import { Card } from "../../../components/ui/card.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import { HeaderActions } from "../../../components/header-actions.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.tsx";
import { ConfirmDialog } from "../../../components/ui/confirm-dialog.tsx";
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
      queryClient.invalidateQueries({
        queryKey: trpc.project.listProjectRepos.queryKey({
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

function useRemoveRepo(params: { organizationSlug: string; projectSlug: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) =>
      trpcClient.project.removeProjectRepo.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        repoId,
      }),
    onSuccess: () => {
      toast.success("Repository removed");
      queryClient.invalidateQueries({
        queryKey: trpc.project.bySlug.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
      queryClient.invalidateQueries({
        queryKey: trpc.project.listProjectRepos.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
    },
    onError: (error) => {
      toast.error(`Failed to remove repository: ${error.message}`);
    },
  });
}

export const Route = createFileRoute("/_auth/orgs/$organizationSlug/projects/$projectSlug/repo")({
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
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/repo",
  });
  const [isAddingRepo, setIsAddingRepo] = useState(false);
  const [repoToDelete, setRepoToDelete] = useState<{
    id: string;
    owner: string;
    name: string;
  } | null>(null);

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

  const repos = project?.projectRepos ?? [];

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
  const removeRepo = useRemoveRepo(params);

  if (!githubConnection.connected) {
    return (
      <div className="p-4 md:p-8">
        <EmptyState
          icon={<GitBranch className="h-12 w-12" />}
          title="No GitHub connected"
          description="Connect your GitHub account to link repositories."
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
    );
  }

  if (isAddingRepo) {
    return (
      <div className="p-4 md:p-8">
        <Suspense fallback={<RepoPickerSkeleton />}>
          <RepoPicker
            params={params}
            existingRepos={repos}
            onCancel={() => setIsAddingRepo(false)}
          />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8">
      <HeaderActions>
        <Button variant="outline" size="sm" onClick={() => setIsAddingRepo(true)}>
          <Plus className="h-4 w-4" />
          <span className="sr-only">Add Repository</span>
        </Button>
      </HeaderActions>

      {repos.length === 0 ? (
        <EmptyState
          icon={<GitBranch className="h-12 w-12" />}
          title="No repositories linked"
          description="Add a repository to get started."
          action={
            <Button onClick={() => setIsAddingRepo(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Repository
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {repos.map((repo) => (
            <Card key={repo.id} className="p-6">
              <div className="flex items-start gap-4">
                <div className="rounded-md border bg-muted p-2">
                  <Github className="h-6 w-6" />
                </div>
                <div className="flex-1 space-y-2">
                  <div>
                    <h2 className="text-lg font-semibold">
                      {repo.owner}/{repo.name}
                    </h2>
                    <p className="text-sm text-muted-foreground">Branch: {repo.defaultBranch}</p>
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
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  onClick={() => setRepoToDelete(repo)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-6 border-t pt-6">
        <Button
          variant="outline"
          onClick={() => disconnectGithub.mutate()}
          disabled={disconnectGithub.isPending}
          className="text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
        >
          {disconnectGithub.isPending ? <Spinner className="mr-2" /> : null}
          Disconnect GitHub
        </Button>
        <p className="mt-2 text-sm text-muted-foreground">
          This will remove all linked repositories and disconnect your GitHub account.
        </p>
      </div>

      <ConfirmDialog
        open={!!repoToDelete}
        onOpenChange={(open) => !open && setRepoToDelete(null)}
        title="Remove repository?"
        description={`This will remove ${repoToDelete?.owner}/${repoToDelete?.name} from this project. The repository itself will not be affected.`}
        confirmLabel="Remove"
        onConfirm={() => repoToDelete && removeRepo.mutate(repoToDelete.id)}
        destructive
      />
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
  existingRepos,
  onCancel,
}: {
  params: { organizationSlug: string; projectSlug: string };
  existingRepos: { owner: string; name: string }[];
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedRepo, setSelectedRepo] = useState<{
    id: number;
    owner: string;
    name: string;
    defaultBranch: string;
  } | null>(null);

  const { data: reposData } = useSuspenseQuery(
    trpc.project.listAvailableGithubRepos.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const addProjectRepo = useMutation({
    mutationFn: (repo: { id: number; owner: string; name: string; defaultBranch: string }) =>
      trpcClient.project.addProjectRepo.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        repoId: repo.id,
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
      }),
    onSuccess: () => {
      toast.success("Repository added successfully");
      queryClient.invalidateQueries({
        queryKey: trpc.project.bySlug.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
      queryClient.invalidateQueries({
        queryKey: trpc.project.listProjectRepos.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
      onCancel?.();
    },
    onError: (error) => {
      toast.error(`Failed to add repository: ${error.message}`);
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

  const existingRepoKeys = new Set(existingRepos.map((r) => `${r.owner}/${r.name}`));
  const availableRepositories = reposData.repositories.filter(
    (repo) => !existingRepoKeys.has(repo.fullName),
  );

  if (availableRepositories.length === 0) {
    return (
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">
          {reposData.repositories.length === 0
            ? "No repositories found. Make sure you have granted access to at least one repository during GitHub App installation."
            : "All available repositories have already been added."}
        </p>
        <div className="mt-4 flex gap-2">
          <Button
            variant="outline"
            onClick={() => updateGithubPermissions.mutate()}
            disabled={updateGithubPermissions.isPending}
          >
            {updateGithubPermissions.isPending ? <Spinner className="mr-2" /> : null}
            Update GitHub permissions
          </Button>
          {onCancel && (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">Select a repository</h2>
          <p className="text-sm text-muted-foreground">
            Choose which repository to add to this project.
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
            {availableRepositories.map((repo) => (
              <DropdownMenuItem
                key={repo.id}
                onClick={() =>
                  setSelectedRepo({
                    id: repo.id,
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
            onClick={() => selectedRepo && addProjectRepo.mutate(selectedRepo)}
            disabled={!selectedRepo || addProjectRepo.isPending}
          >
            {addProjectRepo.isPending ? <Spinner className="mr-2" /> : null}
            Add repository
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
