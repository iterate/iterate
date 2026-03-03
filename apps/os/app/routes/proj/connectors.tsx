import { Suspense, useEffect, useState } from "react";
import { createFileRoute, useParams, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, ExternalLink, Github, ChevronDown, Check } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod/v4";
import { Button } from "../../components/ui/button.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemGroup,
} from "../../components/ui/item.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import { orpc, orpcClient } from "../../lib/orpc.tsx";

const Search = z.object({ error: z.string().optional() });

export const Route = createFileRoute("/_auth/proj/$projectSlug/connectors")({
  validateSearch: Search,
  component: ProjectConnectorsPage,
});

function ProjectConnectorsPage() {
  const params = useParams({ from: "/_auth/proj/$projectSlug/connectors" });
  const search = useSearch({ from: "/_auth/proj/$projectSlug/connectors" });
  const queryClient = useQueryClient();

  useEffect(() => {
    if (search.error === "slack_oauth_denied") toast.error("Slack authorization was denied.");
    if (search.error === "google_oauth_denied") toast.error("Google authorization was denied.");
  }, [search.error]);

  const { data: slackConnection } = useSuspenseQuery(
    orpc.project.getSlackConnection.queryOptions({
      input: {
        projectSlug: params.projectSlug,
      },
    }),
  );

  const startSlackOAuth = useMutation({
    mutationFn: () =>
      orpcClient.project.startSlackOAuthFlow({
        projectSlug: params.projectSlug,
      }),
    onSuccess: (data) => {
      window.location.href = data.authorizationUrl;
    },
    onError: (error) => toast.error(`Failed to start Slack connection: ${error.message}`),
  });

  const disconnectSlack = useMutation({
    mutationFn: () =>
      orpcClient.project.disconnectSlack({
        projectSlug: params.projectSlug,
      }),
    onSuccess: () => {
      toast.success("Slack disconnected");
      queryClient.invalidateQueries({
        queryKey: orpc.project.getSlackConnection.key({
          input: {
            projectSlug: params.projectSlug,
          },
        }),
      });
    },
    onError: (error) => toast.error(`Failed to disconnect Slack: ${error.message}`),
  });

  const { data: googleConnection } = useSuspenseQuery(
    orpc.project.getGoogleConnection.queryOptions({
      input: {
        projectSlug: params.projectSlug,
      },
    }),
  );

  const startGoogleOAuth = useMutation({
    mutationFn: () =>
      orpcClient.project.startGoogleOAuthFlow({
        projectSlug: params.projectSlug,
      }),
    onSuccess: (data) => {
      window.location.href = data.authorizationUrl;
    },
    onError: (error) => toast.error(`Failed to start Google connection: ${error.message}`),
  });

  const disconnectGoogle = useMutation({
    mutationFn: () =>
      orpcClient.project.disconnectGoogle({
        projectSlug: params.projectSlug,
      }),
    onSuccess: () => {
      toast.success("Google disconnected");
      queryClient.invalidateQueries({
        queryKey: orpc.project.getGoogleConnection.key({
          input: {
            projectSlug: params.projectSlug,
          },
        }),
      });
    },
    onError: (error) => toast.error(`Failed to disconnect Google: ${error.message}`),
  });

  const { data: project } = useSuspenseQuery(
    orpc.project.bySlug.queryOptions({
      input: { projectSlug: params.projectSlug },
    }),
  );

  const { data: githubConnection } = useSuspenseQuery(
    orpc.project.getGithubConnection.queryOptions({
      input: {
        projectSlug: params.projectSlug,
      },
    }),
  );

  const configRepo = project?.configRepoFullName
    ? (() => {
        const [owner, name] = project.configRepoFullName.split("/");
        if (!owner || !name) return null;
        return {
          owner,
          name,
          defaultBranch: project.configRepoDefaultBranch ?? "main",
        };
      })()
    : null;

  return (
    <div className="space-y-8 p-4">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Project connections</h2>
          <p className="text-sm text-muted-foreground">
            External services connected to this project.
          </p>
        </div>
        <ItemGroup className="space-y-3">
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
                  {startSlackOAuth.isPending && <Spinner className="mr-2" />}Add to Slack
                </Button>
              )}
            </ItemActions>
          </Item>

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
                {project?.configRepoFullName
                  ? `Config repo: ${project.configRepoFullName}`
                  : "No config repo selected. Using default template config."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <GitHubConfigRepoSetup
                projectSlug={params.projectSlug}
                connected={githubConnection.connected}
                configRepo={project?.configRepoId ? configRepo : null}
              />
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
                  <span>
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

function GitHubConfigRepoSetup({
  projectSlug,
  connected,
  configRepo,
}: {
  projectSlug: string;
  connected: boolean;
  configRepo: {
    owner: string;
    name: string;
    defaultBranch: string;
  } | null;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const startGithubInstall = useMutation({
    mutationFn: () => orpcClient.project.startGithubInstallFlow({ projectSlug }),
    onSuccess: (data) => {
      window.location.href = data.installationUrl;
    },
    onError: (error) => toast.error(`Failed to start GitHub install: ${error.message}`),
  });

  const setConfigRepo = useMutation({
    mutationFn: (
      repo: {
        id: number;
        owner: string;
        name: string;
        defaultBranch: string;
      } | null,
    ) => orpcClient.project.setConfigRepo({ projectSlug, repo }),
    onSuccess: async () => {
      toast.success("Config repository updated");
      await queryClient.invalidateQueries({
        queryKey: orpc.project.bySlug.key({ input: { projectSlug } }),
      });
      setOpen(false);
    },
    onError: (error) => toast.error(`Failed to update config repository: ${error.message}`),
  });

  const disconnectGithub = useMutation({
    mutationFn: () => orpcClient.project.disconnectGithub({ projectSlug }),
    onSuccess: () => {
      toast.success("GitHub disconnected");
      queryClient.invalidateQueries({
        queryKey: orpc.project.bySlug.key({ input: { projectSlug } }),
      });
      queryClient.invalidateQueries({
        queryKey: orpc.project.getGithubConnection.key({
          input: { projectSlug },
        }),
      });
      setOpen(false);
    },
    onError: (error) => toast.error(`Failed to disconnect GitHub: ${error.message}`),
  });

  if (!connected) {
    return (
      <Button
        size="sm"
        onClick={() => startGithubInstall.mutate()}
        disabled={startGithubInstall.isPending}
      >
        {startGithubInstall.isPending ? <Spinner className="mr-2" /> : null}
        Connect GitHub
      </Button>
    );
  }

  return (
    <>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => setOpen(true)} disabled={setConfigRepo.isPending}>
          {configRepo ? "Change Config repo" : "Setup Config repo"}
        </Button>
        {configRepo ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfigRepo.mutate(null)}
            disabled={setConfigRepo.isPending}
            className="text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
          >
            Remove Config repo
          </Button>
        ) : null}
        {connected && !configRepo ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => disconnectGithub.mutate()}
            disabled={disconnectGithub.isPending}
            className="text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
          >
            {disconnectGithub.isPending ? <Spinner className="mr-2" /> : null}
            Disconnect GitHub
          </Button>
        ) : null}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Setup Config repo</DialogTitle>
            <DialogDescription>
              Choose the GitHub repository that stores your iterate config.
            </DialogDescription>
          </DialogHeader>

          <Suspense fallback={<RepoPickerSkeleton />}>
            <ConfigRepoPicker
              projectSlug={projectSlug}
              onSetConfigRepo={(repo) => setConfigRepo.mutateAsync(repo)}
            />
          </Suspense>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RepoPickerSkeleton() {
  return (
    <div className="flex items-center gap-2 py-4">
      <Spinner />
      <span className="text-sm text-muted-foreground">Loading repositories...</span>
    </div>
  );
}

function ConfigRepoPicker({
  projectSlug,
  onSetConfigRepo,
}: {
  projectSlug: string;
  onSetConfigRepo: (
    repo: {
      id: number;
      owner: string;
      name: string;
      defaultBranch: string;
    } | null,
  ) => Promise<unknown>;
}) {
  const [selectedRepo, setSelectedRepo] = useState<{
    id: number;
    owner: string;
    name: string;
    defaultBranch: string;
  } | null>(null);

  const { data: reposData } = useSuspenseQuery(
    orpc.project.listAvailableGithubRepos.queryOptions({
      input: { projectSlug },
    }),
  );

  const saveConfigRepo = useMutation({
    mutationFn: (repo: { id: number; owner: string; name: string; defaultBranch: string }) =>
      onSetConfigRepo(repo),
    onError: (error) => toast.error(`Failed to set config repository: ${error.message}`),
  });

  const updateGithubPermissions = useMutation({
    mutationFn: () => orpcClient.project.startGithubInstallFlow({ projectSlug }),
    onSuccess: (data) => {
      window.location.href = data.installationUrl;
    },
    onError: (error) => toast.error(`Failed to update GitHub permissions: ${error.message}`),
  });

  const allRepositories = reposData.repositories;

  if (allRepositories.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          No repositories found. Make sure you granted access during GitHub App install.
        </p>
        <div>
          <Button
            variant="outline"
            onClick={() => updateGithubPermissions.mutate()}
            disabled={updateGithubPermissions.isPending}
          >
            {updateGithubPermissions.isPending ? <Spinner className="mr-2" /> : null}
            Update GitHub permissions
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium">Select a repository</h2>
        <p className="text-sm text-muted-foreground">
          This repo will be used to load iterate.config.ts.
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full justify-between">
            {selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : "Select repository..."}
            <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-[300px] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto">
          {allRepositories.map((repo) => (
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
          onClick={() => {
            if (!selectedRepo) return;
            saveConfigRepo.mutate(selectedRepo);
          }}
          disabled={!selectedRepo || saveConfigRepo.isPending}
        >
          {saveConfigRepo.isPending ? <Spinner className="mr-2" /> : null}
          Save config repo
        </Button>
      </div>
    </div>
  );
}
