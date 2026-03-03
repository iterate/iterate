import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod/v4";
import { match } from "ts-pattern";
import { Button } from "../components/ui/button.tsx";
import { CenteredLayout } from "../components/centered-layout.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { orpc, orpcClient } from "../lib/orpc.tsx";

const Search = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("slack"),
    teamId: z.string(),
    teamName: z.string(),
    newProjectId: z.string(),
  }),
  z.object({
    kind: z.literal("github-installation"),
    installationId: z.number(),
    newProjectId: z.string(),
  }),
]);

export const Route = createFileRoute("/_auth/connection-conflict")({
  validateSearch: Search,
  component: ConnectionConflictPage,
});

function ConnectionConflictPage() {
  const search = Route.useSearch();
  const { data: newProject } = useSuspenseQuery(
    orpc.project.getProjectInfoById.queryOptions({
      input: { projectId: search.newProjectId },
    }),
  );

  return match(search)
    .with({ kind: "slack" }, (data) => (
      <SlackConflictPage teamId={data.teamId} teamName={data.teamName} newProject={newProject} />
    ))
    .with({ kind: "github-installation" }, (data) => (
      <GithubInstallationConflictPage
        installationId={data.installationId}
        newProject={newProject}
      />
    ))
    .otherwise(() => <div>Invalid conflict</div>);
}

function SlackConflictPage({
  teamId,
  teamName,
  newProject,
}: {
  teamId: string;
  teamName: string;
  newProject: { id: string; slug: string; organizationName: string };
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const transferConnection = useMutation({
    mutationFn: () =>
      orpcClient.project.transferSlackConnection({
        projectSlug: newProject.slug,
        slackTeamId: teamId,
      }),
    onSuccess: (result) => {
      toast.success(`Slack workspace connected to ${newProject.slug}`);
      queryClient.invalidateQueries({
        queryKey: orpc.project.getSlackConnection.key({
          input: { projectSlug: newProject.slug },
        }),
      });

      if (result.previousProjectSlug) {
        queryClient.invalidateQueries({
          queryKey: orpc.project.getSlackConnection.key({
            input: { projectSlug: result.previousProjectSlug },
          }),
        });
      }

      navigate({
        to: "/proj/$projectSlug/connectors",
        params: { projectSlug: newProject.slug },
      });
    },
    onError: (error) => {
      toast.error(`Failed to transfer connection: ${error.message}`);
    },
  });

  return (
    <CenteredLayout>
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
            <AlertTriangle className="h-6 w-6 text-amber-500" />
          </div>
          <h1 className="text-2xl font-semibold">Slack workspace already connected</h1>
        </div>

        <p className="text-muted-foreground">
          The Slack workspace <span className="font-medium text-foreground">{teamName}</span> is
          already connected to another Iterate project. Do you want to replace that connection with
          this project?
        </p>

        <div className="grid grid-cols-2 gap-4">
          <Button
            variant="outline"
            className="h-auto flex-col items-start gap-3 p-4 text-left"
            onClick={() =>
              navigate({
                to: "/proj/$projectSlug/connectors",
                params: { projectSlug: newProject.slug },
              })
            }
          >
            <span className="text-sm font-medium">Keep existing connection</span>
            <div className="w-full space-y-1 text-xs text-muted-foreground">
              <div className="flex justify-between">
                <span>Slack workspace</span>
                <span className="font-mono text-foreground">{teamName}</span>
              </div>
            </div>
          </Button>

          <Button
            className="h-auto flex-col items-start gap-3 p-4 text-left"
            onClick={() => transferConnection.mutate()}
            disabled={transferConnection.isPending}
          >
            {transferConnection.isPending ? (
              <div className="flex items-center gap-2">
                <Spinner className="h-4 w-4" />
                <span className="text-sm font-medium">Switching...</span>
              </div>
            ) : (
              <span className="text-sm font-medium">Replace with this project</span>
            )}
            <div className="w-full space-y-1 text-xs text-primary-foreground/70">
              <div className="flex justify-between">
                <span>Slack workspace</span>
                <span className="font-mono text-primary-foreground">{teamName}</span>
              </div>
              <div className="flex justify-between">
                <span>Iterate organization</span>
                <span className="font-mono text-primary-foreground">
                  {newProject.organizationName}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Iterate project</span>
                <span className="font-mono text-primary-foreground">{newProject.slug}</span>
              </div>
            </div>
          </Button>
        </div>
      </div>
    </CenteredLayout>
  );
}

function GithubInstallationConflictPage({
  installationId,
  newProject,
}: {
  installationId: number;
  newProject: { id: string; slug: string; organizationName: string };
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const transferConnection = useMutation({
    mutationFn: () =>
      orpcClient.project.transferGithubConnection({
        projectSlug: newProject.slug,
        installationId,
      }),
    onSuccess: (result) => {
      toast.success(`GitHub connection moved to ${newProject.slug}`);
      queryClient.invalidateQueries({
        queryKey: orpc.project.bySlug.key({
          input: { projectSlug: newProject.slug },
        }),
      });
      queryClient.invalidateQueries({
        queryKey: orpc.project.getGithubConnection.key({
          input: { projectSlug: newProject.slug },
        }),
      });

      if (result.previousProjectSlug) {
        queryClient.invalidateQueries({
          queryKey: orpc.project.bySlug.key({
            input: { projectSlug: result.previousProjectSlug },
          }),
        });
        queryClient.invalidateQueries({
          queryKey: orpc.project.getGithubConnection.key({
            input: { projectSlug: result.previousProjectSlug },
          }),
        });
      }

      navigate({
        to: "/proj/$projectSlug/connectors",
        params: { projectSlug: newProject.slug },
      });
    },
    onError: (error) => {
      toast.error(`Failed to transfer connection: ${error.message}`);
    },
  });

  return (
    <CenteredLayout>
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
            <AlertTriangle className="h-6 w-6 text-amber-500" />
          </div>
          <h1 className="text-2xl font-semibold">GitHub connection already in use</h1>
        </div>

        <p className="text-muted-foreground">
          This GitHub App installation is already connected to another Iterate project. Do you want
          to replace that connection with this project?
        </p>

        <div className="grid grid-cols-2 gap-4">
          <Button
            variant="outline"
            className="h-auto flex-col items-start gap-3 p-4 text-left"
            onClick={() =>
              navigate({
                to: "/proj/$projectSlug/connectors",
                params: { projectSlug: newProject.slug },
              })
            }
          >
            <span className="text-sm font-medium">Keep existing connection</span>
            <div className="w-full space-y-1 text-xs text-muted-foreground">
              <div className="flex justify-between">
                <span>GitHub installation</span>
                <span className="font-mono text-foreground">{installationId}</span>
              </div>
            </div>
          </Button>

          <Button
            className="h-auto flex-col items-start gap-3 p-4 text-left"
            onClick={() => transferConnection.mutate()}
            disabled={transferConnection.isPending}
          >
            {transferConnection.isPending ? (
              <div className="flex items-center gap-2">
                <Spinner className="h-4 w-4" />
                <span className="text-sm font-medium">Switching...</span>
              </div>
            ) : (
              <span className="text-sm font-medium">Replace with this project</span>
            )}
            <div className="w-full space-y-1 text-xs text-primary-foreground/70">
              <div className="flex justify-between">
                <span>GitHub installation</span>
                <span className="font-mono text-primary-foreground">{installationId}</span>
              </div>
              <div className="flex justify-between">
                <span>Iterate organization</span>
                <span className="font-mono text-primary-foreground">
                  {newProject.organizationName}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Iterate project</span>
                <span className="font-mono text-primary-foreground">{newProject.slug}</span>
              </div>
            </div>
          </Button>
        </div>
      </div>
    </CenteredLayout>
  );
}
