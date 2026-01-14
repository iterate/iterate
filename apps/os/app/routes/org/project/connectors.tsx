import { Suspense, useEffect } from "react";
import { createFileRoute, useParams, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, ExternalLink, Webhook } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod/v4";
import { Button } from "../../../components/ui/button.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select.tsx";
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
    }
  }, [search.error]);

  const { data: slackConnection } = useSuspenseQuery(
    trpc.project.getSlackConnection.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const { data: webhookTarget } = useSuspenseQuery(
    trpc.project.getSlackWebhookTargetMachine.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const { data: machines } = useSuspenseQuery(
    trpc.machine.list.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
      includeArchived: false,
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
      queryClient.invalidateQueries({
        queryKey: trpc.project.getSlackWebhookTargetMachine.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
    },
    onError: (error) => {
      toast.error(`Failed to disconnect Slack: ${error.message}`);
    },
  });

  const setWebhookTarget = useMutation({
    mutationFn: (machineId: string | null) =>
      trpcClient.project.setSlackWebhookTargetMachine.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId,
      }),
    onSuccess: () => {
      toast.success("Webhook target updated");
      queryClient.invalidateQueries({
        queryKey: trpc.project.getSlackWebhookTargetMachine.queryKey({
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        }),
      });
    },
    onError: (error) => {
      toast.error(`Failed to update webhook target: ${error.message}`);
    },
  });

  // Filter to only show started machines as webhook targets
  const availableMachines = machines.filter((m) => m.state === "started");

  // Determine effective webhook target: explicit selection or auto-selected first machine
  const explicitTarget = webhookTarget.webhookTargetMachine;
  const autoSelectedTarget =
    !explicitTarget && availableMachines.length > 0 ? availableMachines[0] : null;

  return (
    <div className="p-4 md:p-8 space-y-8">
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

          {/* Slack Webhook Target - only show when Slack is connected */}
          {slackConnection.connected && (
            <Item variant="muted" className="ml-12">
              <ItemMedia variant="icon">
                <Webhook className="h-4 w-4" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Webhook Target</ItemTitle>
                <ItemDescription>
                  {availableMachines.length === 0
                    ? "No running machines available. Start a machine to receive webhooks."
                    : "Forward incoming Slack webhooks to a machine's daemon."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Select
                  value={explicitTarget?.id ?? "auto"}
                  onValueChange={(value) => {
                    // "auto" means use default (null in DB), specific ID means explicit selection
                    setWebhookTarget.mutate(value === "auto" ? null : value);
                  }}
                  disabled={setWebhookTarget.isPending || availableMachines.length === 0}
                >
                  <SelectTrigger className="w-[220px]">
                    <SelectValue placeholder="Select machine" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      {autoSelectedTarget
                        ? `Auto (${autoSelectedTarget.name})`
                        : "Auto (first started)"}
                    </SelectItem>
                    {availableMachines.map((machine) => (
                      <SelectItem key={machine.id} value={machine.id}>
                        {machine.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </ItemActions>
            </Item>
          )}
        </ItemGroup>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Your connections</h2>
          <p className="text-sm text-muted-foreground">Only visible to you inside this project.</p>
        </div>

        <ItemGroup className="space-y-3">
          {/* Gmail - Coming Soon */}
          <Item variant="outline">
            <ItemMedia variant="icon">
              <Mail className="h-4 w-4" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                Gmail
                <Badge variant="outline" className="ml-2">
                  Coming soon
                </Badge>
              </ItemTitle>
              <ItemDescription>Gmail and Calendar access for your account.</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button size="sm" disabled>
                Connect Gmail
              </Button>
            </ItemActions>
          </Item>
        </ItemGroup>
      </section>
    </div>
  );
}
