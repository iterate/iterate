import { Suspense, useEffect, useState } from "react";
import { createFileRoute, useParams, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Mail,
  MessageSquare,
  ExternalLink,
  Github,
  Plus,
  Trash2,
  ChevronDown,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { z } from "zod/v4";
import { Button } from "../../../components/ui/button.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemGroup,
} from "../../../components/ui/item.tsx";
import { Card } from "../../../components/ui/card.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.tsx";
import { ConfirmDialog } from "../../../components/ui/confirm-dialog.tsx";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";

const Search = z.object({
  error: z.string().optional(),
});

export const Route = createFileRoute(
  "/_auth/orgs/$organizationSlug/projects/$projectSlug/connectors",
)({
  validateSearch: Search,
  component: ProjectConnectorsPage,
});

function ProjectConnectorsPage() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/connectors",
  });
  const search = useSearch({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/connectors",
  });
  const queryClient = useQueryClient();

  useEffect(() => {
    // Note: slack_workspace_already_connected now redirects to /slack-conflict instead
    if (search.error === "slack_oauth_denied") {
      toast.error("Slack authorization was denied.");
    } else if (search.error === "google_oauth_denied") {
      toast.error("Google authorization was denied.");
    }
  }, [search.error]);

  const { data: slackConnection } = useSuspenseQuery(
    trpc.project.getSlackConnection.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const startSlackOAuth = useMutation({
    mutationFn: () =>
      trpcClient.project.startSlackOAuthFlow.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: (data) => {
      window.location.href = data.authorizationUrl;
    },
    onError: (error) => {
      toast.error(`Failed to start Slack connection: ${error.message}`);
    },
  });

  const disconnectSlack = useMutation({
    mutationFn: () =>
      trpcClient.project.disconnectSlack.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: () => {
      toast.success("Slack disconnected");
      queryClient.invalidateQueries({
        queryKey: trpc.project.getSlackConnection.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
    },
    onError: (error) => {
      toast.error(`Failed to disconnect Slack: ${error.message}`);
    },
  });

  // Google connection (user-scoped)
  const { data: googleConnection } = useSuspenseQuery(
    trpc.project.getGoogleConnection.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const startGoogleOAuth = useMutation({
    mutationFn: () =>
      trpcClient.project.startGoogleOAuthFlow.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: (data) => {
      window.location.href = data.authorizationUrl;
    },
    onError: (error) => {
      toast.error(`Failed to start Google connection: ${error.message}`);
    },
  });

  const disconnectGoogle = useMutation({
    mutationFn: () =>
      trpcClient.project.disconnectGoogle.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    onSuccess: () => {
      toast.success("Google disconnected");
      queryClient.invalidateQueries({
        queryKey: trpc.project.getGoogleConnection.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
    },
    onError: (error) => {
      toast.error(`Failed to disconnect Google: ${error.message}`);
    },
  });

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

  return (
    <div className="p-4 space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Project connections</h2>
          <p className="text-sm text-muted-foreground">
            External services connected to this project.
          </p>
        </div>

        <ItemGroup className="space-y-3">
          {/* Slack Connection */}
          <Item variant="outline">
            <ItemMedia variant="icon">
              <MessageSquare className="h-4 w-4" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                Slack
                {slackConnection.connected && (
                  <Badge variant="secondary" className="ml-2">
                    Connected
                  </Badge>
                )}
              </ItemTitle>
              <ItemDescription>
                {slackConnection.connected && slackConnection.teamName ? (
                  <span className="flex items-center gap-2">
                    Connected to{" "}
                    <span className="font-medium text-foreground">{slackConnection.teamName}</span>
                    {slackConnection.teamDomain && (
                      <a
                        href={`https://${slackConnection.teamDomain}.slack.com`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </span>
                ) : (
                  "Receive messages and run commands from Slack."
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {slackConnection.connected ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnectSlack.mutate()}
                  disabled={disconnectSlack.isPending}
                  className="text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
                >
                  {disconnectSlack.isPending && <Spinner className="mr-2" />}
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => startSlackOAuth.mutate()}
                  disabled={startSlackOAuth.isPending}
                >
                  {startSlackOAuth.isPending && <Spinner className="mr-2" />}
                  Add to Slack
                </Button>
              )}
            </ItemActions>
          </Item>

          {/* GitHub Connection */}
          <Item variant="outline">
            <ItemMedia variant="icon">
              <Github className="h-4 w-4" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                GitHub
                {githubConnection.connected && (
                  <Badge variant="secondary" className="ml-2">
                    Connected
                  </Badge>
                )}
              </ItemTitle>
              <ItemDescription>
                {githubConnection.connected ? (
                  repos.length > 0 ? (
                    <span>
                      {repos.length} {repos.length === 1 ? "repository" : "repositories"} linked
                    </span>
                  ) : (
                    "Connected. Add repositories below."
                  )
                ) : (
                  "Link GitHub repositories to this project."
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {githubConnection.connected ? (
                <GitHubManagement params={params} repos={repos} />
              ) : (
                <GitHubConnect params={params} />
              )}
            </ItemActions>
          </Item>
        </ItemGroup>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Your connections</h2>
          <p className="text-sm text-muted-foreground">Only visible to you inside this project.</p>
        </div>

        <ItemGroup className="space-y-3">
          {/* Google Connection */}
          <Item variant="outline">
            <ItemMedia variant="icon">
              <Mail className="h-4 w-4" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                Google
                {googleConnection.connected && (
                  <Badge variant="secondary" className="ml-2">
                    Connected
                  </Badge>
                )}
              </ItemTitle>
              <ItemDescription>
                {googleConnection.connected && googleConnection.email ? (
                  <span className="flex items-center gap-2">
                    Connected as{" "}
                    <span className="font-medium text-foreground">{googleConnection.email}</span>
                  </span>
                ) : (
                  "Gmail, Calendar, Docs, Sheets, and Drive access for your account."
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {googleConnection.connected ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnectGoogle.mutate()}
                  disabled={disconnectGoogle.isPending}
                  className="text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
                >
                  {disconnectGoogle.isPending && <Spinner className="mr-2" />}
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => startGoogleOAuth.mutate()}
                  disabled={startGoogleOAuth.isPending}
                >
                  {startGoogleOAuth.isPending && <Spinner className="mr-2" />}
                  Connect Google
                </Button>
              )}
            </ItemActions>
          </Item>
        </ItemGroup>
      </section>
    </div>
  );
}

function GitHubConnect({ params }: { params: { organizationSlug: string; projectSlug: string } }) {
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

  return (
    <Button
      size="sm"
      onClick={() => startGithubInstall.mutate()}
      disabled={startGithubInstall.isPending}
    >
      {startGithubInstall.isPending && <Spinner className="mr-2" />}
      Connect GitHub
    </Button>
  );
}

function GitHubManagement({
  params,
  repos,
}: {
  params: { organizationSlug: string; projectSlug: string };
  repos: Array<{ id: string; owner: string; name: string; defaultBranch: string }>;
}) {
  const queryClient = useQueryClient();
  const [showRepos, setShowRepos] = useState(false);
  const [isAddingRepo, setIsAddingRepo] = useState(false);
  const [repoToDelete, setRepoToDelete] = useState<{
    id: string;
    owner: string;
    name: string;
  } | null>(null);

  const disconnectGithub = useMutation({
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

  const removeRepo = useMutation({
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
      setRepoToDelete(null);
    },
    onError: (error) => {
      toast.error(`Failed to remove repository: ${error.message}`);
    },
  });

  if (isAddingRepo) {
    return (
      <div className="w-full mt-4">
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
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setShowRepos(!showRepos)}>
          {showRepos ? "Hide" : "Manage"} Repos
        </Button>
      </div>
      {showRepos && (
        <div className="mt-4 space-y-4 w-full">
          {repos.length > 0 && (
            <div className="space-y-2">
              {repos.map((repo) => (
                <Card key={repo.id} className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className="rounded-md border bg-muted p-1.5">
                        <Github className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="font-medium text-sm">
                          {repo.owner}/{repo.name}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Branch: {repo.defaultBranch}
                        </p>
                        <a
                          href={`https://github.com/${repo.owner}/${repo.name}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1"
                        >
                          View on GitHub
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground shrink-0"
                      onClick={() => setRepoToDelete(repo)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setIsAddingRepo(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Add Repo
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => disconnectGithub.mutate()}
              disabled={disconnectGithub.isPending}
              className="text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
            >
              {disconnectGithub.isPending ? <Spinner className="mr-2" /> : null}
              Disconnect
            </Button>
          </div>
        </div>
      )}
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
