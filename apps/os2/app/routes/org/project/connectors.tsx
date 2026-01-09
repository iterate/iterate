import { Suspense } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../../components/ui/button.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";

export const Route = createFileRoute(
  "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug/connectors",
)({
  component: ProjectConnectorsPage,
});

function ProjectConnectorsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <ProjectConnectorsContent />
    </Suspense>
  );
}

function ProjectConnectorsContent() {
  const params = useParams({
    from: "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug/connectors",
  });
  const queryClient = useQueryClient();

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

  return (
    <div className="p-8 max-w-4xl space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">Connectors</h1>
        <p className="text-sm text-muted-foreground">Connect external services to this project.</p>
      </div>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Project connections</h2>
          <p className="text-sm text-muted-foreground">Shared across this project.</p>
        </div>
        <div className="space-y-4">
          <div className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-md border bg-muted p-2">
                <MessageSquare className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Slack</span>
                  {slackConnection.connected ? <Badge variant="secondary">Connected</Badge> : null}
                </div>
                {slackConnection.connected && slackConnection.teamName ? (
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-muted-foreground">
                      Connected to <span className="font-medium">{slackConnection.teamName}</span>
                    </p>
                    {slackConnection.teamDomain && (
                      <a
                        href={`https://${slackConnection.teamDomain}.slack.com`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Workspace notifications and commands.
                  </p>
                )}
              </div>
            </div>
            {slackConnection.connected ? (
              <Button
                variant="outline"
                onClick={() => disconnectSlack.mutate()}
                disabled={disconnectSlack.isPending}
                className="text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
              >
                {disconnectSlack.isPending ? <Spinner className="mr-2" /> : null}
                Disconnect
              </Button>
            ) : (
              <Button onClick={() => startSlackOAuth.mutate()} disabled={startSlackOAuth.isPending}>
                {startSlackOAuth.isPending ? <Spinner className="mr-2" /> : null}
                Add to Slack
              </Button>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Your connections</h2>
          <p className="text-sm text-muted-foreground">Only visible to you inside this project.</p>
        </div>
        <div className="space-y-4">
          <div className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-md border bg-muted p-2">
                <Mail className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Gmail</span>
                  <Badge variant="outline">Coming soon</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  Gmail and Calendar access for your account.
                </p>
              </div>
            </div>
            <Button disabled>Connect Gmail</Button>
          </div>
        </div>
      </section>
    </div>
  );
}
