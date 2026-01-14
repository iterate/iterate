import { Suspense } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, AlertTriangle } from "lucide-react";
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
      projectId: search.newProjectId,
    }),
  );

  const transferConnection = useMutation({
    mutationFn: () =>
      trpcClient.project.transferSlackConnection.mutate({
        organizationSlug: newProject.organizationSlug,
        projectSlug: newProject.slug,
        slackTeamId: search.teamId,
      }),
    onSuccess: () => {
      toast.success(`Slack workspace connected to ${newProject.slug}`);
      // Invalidate both projects' Slack connection queries
      queryClient.invalidateQueries({
        queryKey: trpc.project.getSlackConnection.queryKey({
          organizationSlug: newProject.organizationSlug,
          projectSlug: newProject.slug,
        }),
      });
      queryClient.invalidateQueries({
        queryKey: trpc.project.getSlackConnection.queryKey({
          organizationSlug: search.existingOrgSlug,
          projectSlug: search.existingProjectSlug,
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
      <div className="w-full max-w-lg space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
            <AlertTriangle className="h-6 w-6 text-amber-500" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Slack workspace already connected</h1>
          </div>
        </div>

        <div className="space-y-4 rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <MessageSquare className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="font-medium">{search.teamName}</div>
              <div className="text-sm text-muted-foreground">Slack workspace</div>
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            This Slack workspace is currently connected to{" "}
            <span className="font-medium text-foreground">{search.existingProjectName}</span> in{" "}
            <span className="font-medium text-foreground">{search.existingOrgName}</span>.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">
            Choose which project your Slack workspace should be connected to
          </p>
          <p className="text-sm text-muted-foreground">
            @iterate's behavior in your Slack will be determined by the project you pick. If you
            switch to the new project, agents in the other project will no longer respond to
            messages to @iterate.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <Button variant="outline" className="w-full justify-start" onClick={handleKeepExisting}>
            Keep connected to{" "}
            <span className="ml-1 font-mono text-xs">{search.existingProjectSlug}</span>
          </Button>

          <Button
            className="w-full justify-start"
            onClick={() => transferConnection.mutate()}
            disabled={transferConnection.isPending}
          >
            {transferConnection.isPending && <Spinner className="mr-2" />}
            Switch to <span className="ml-1 font-mono text-xs">{newProject.slug}</span>
          </Button>
        </div>
      </div>
    </CenteredLayout>
  );
}
