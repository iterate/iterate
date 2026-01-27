import { Suspense, useEffect } from "react";
import { createFileRoute, useParams, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, ExternalLink } from "lucide-react";
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
import { trpc, trpcClient } from "../../../lib/trpc.tsx";

const Search = z.object({
  error: z.string().optional(),
});

export const Route = createFileRoute(
  "/_auth/orgs/$organizationSlug/projects/$projectSlug/connectors",
)({
  component: ProjectConnectorsPage,
  validateSearch: Search,
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
