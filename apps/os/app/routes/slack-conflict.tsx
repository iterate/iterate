import { Suspense } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod/v4";
import { Button } from "../components/ui/button.tsx";
import { CenteredLayout } from "../components/centered-layout.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { trpc, trpcClient } from "../lib/trpc.tsx";

const Search = z.object({
  teamId: z.string(),
  teamName: z.string(),
  existingProjectSlug: z.string(),
  existingProjectName: z.string(),
  existingOrgSlug: z.string(),
  existingOrgName: z.string(),
  newProjectId: z.string(),
});

export const Route = createFileRoute("/_auth/slack-conflict")({
  component: SlackConflictPage,
  validateSearch: Search,
});

function SlackConflictPage() {
  return (
    <Suspense
      fallback={
        <CenteredLayout>
          <div className="flex items-center justify-center">
            <Spinner />
          </div>
        </CenteredLayout>
      }
    >
      <SlackConflictContent />
    </Suspense>
  );
}

function SlackConflictContent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ from: "/_auth/slack-conflict" });

  // Get the new project's info (slug, org slug) for navigation
  const { data: newProject } = useSuspenseQuery(
    trpc.project.getProjectInfoById.queryOptions({
      input: { projectId: search.newProjectId },
    }),
  );

  const transferConnection = useMutation({
    mutationFn: () =>
      trpcClient.project.transferSlackConnection({
        organizationSlug: newProject.organizationSlug,
        projectSlug: newProject.slug,
        slackTeamId: search.teamId,
      }),
    onSuccess: () => {
      toast.success(`Slack workspace connected to ${newProject.slug}`);
      // Invalidate both projects' Slack connection queries
      queryClient.invalidateQueries({
        queryKey: trpc.project.getSlackConnection.queryKey({
          input: {
            organizationSlug: newProject.organizationSlug,
            projectSlug: newProject.slug,
          },
        }),
      });
      queryClient.invalidateQueries({
        queryKey: trpc.project.getSlackConnection.queryKey({
          input: {
            organizationSlug: search.existingOrgSlug,
            projectSlug: search.existingProjectSlug,
          },
        }),
      });
      navigate({
        to: "/orgs/$organizationSlug/projects/$projectSlug/connectors",
        params: {
          organizationSlug: newProject.organizationSlug,
          projectSlug: newProject.slug,
        },
      });
    },
    onError: (error) => {
      toast.error(`Failed to transfer connection: ${error.message}`);
    },
  });

  const handleKeepExisting = () => {
    navigate({
      to: "/orgs/$organizationSlug/projects/$projectSlug/connectors",
      params: {
        organizationSlug: search.existingOrgSlug,
        projectSlug: search.existingProjectSlug,
      },
    });
  };

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
          The Slack workspace <span className="font-medium text-foreground">{search.teamName}</span>{" "}
          is already connected to an Iterate project. Choose which project should receive messages
          from this Slack workspace.
        </p>

        <div className="grid grid-cols-2 gap-4">
          <Button
            variant="outline"
            className="h-auto flex-col items-start gap-3 p-4 text-left"
            onClick={handleKeepExisting}
          >
            <span className="text-sm font-medium">Keep current connection</span>
            <div className="w-full space-y-1 text-xs text-muted-foreground">
              <div className="flex justify-between">
                <span>Slack workspace</span>
                <span className="font-mono text-foreground">{search.teamName}</span>
              </div>
              <div className="flex justify-between">
                <span>Iterate organization</span>
                <span className="font-mono text-foreground">{search.existingOrgName}</span>
              </div>
              <div className="flex justify-between">
                <span>Iterate project</span>
                <span className="font-mono text-foreground">{search.existingProjectSlug}</span>
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
              <span className="text-sm font-medium">Switch to new project</span>
            )}
            <div className="w-full space-y-1 text-xs text-primary-foreground/70">
              <div className="flex justify-between">
                <span>Slack workspace</span>
                <span className="font-mono text-primary-foreground">{search.teamName}</span>
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
