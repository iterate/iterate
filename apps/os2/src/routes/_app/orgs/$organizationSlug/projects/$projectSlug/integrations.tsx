import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@iterate-com/ui/components/item";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { toast } from "@iterate-com/ui/components/sonner";
import { Mail, MessageSquare } from "lucide-react";
import { z } from "zod";
import { orpc } from "~/orpc/client.ts";

const Search = z.object({
  error: z.string().optional(),
});

export const Route = createFileRoute(
  "/_app/orgs/$organizationSlug/projects/$projectSlug/integrations",
)({
  validateSearch: Search,
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });

    return {
      breadcrumb: "Integrations",
      project,
    };
  },
  component: ProjectIntegrationsPage,
});

function ProjectIntegrationsPage() {
  const search = Route.useSearch();
  const { project } = Route.useLoaderData();
  const queryClient = useQueryClient();
  const projectSlugOrId = project.id;
  const slackQuery = orpc.project.integrations.getSlackConnection.queryOptions({
    input: { projectSlugOrId },
  });
  const googleQuery = orpc.project.integrations.getGoogleConnection.queryOptions({
    input: { projectSlugOrId },
  });
  const { data: slackConnection } = useQuery(slackQuery);
  const { data: googleConnection } = useQuery(googleQuery);

  useEffect(() => {
    if (!search.error) return;
    toast.error(search.error.replaceAll("_", " "));
  }, [search.error]);

  const startSlack = useMutation(
    orpc.project.integrations.startSlackOAuthFlow.mutationOptions({
      onSuccess: (result) => {
        window.location.href = result.authorizationUrl;
      },
      onError: (error) => toast.error(`Failed to connect Slack: ${error.message}`),
    }),
  );
  const disconnectSlack = useMutation(
    orpc.project.integrations.disconnectSlack.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: slackQuery.queryKey });
        toast.success("Slack disconnected");
      },
      onError: (error) => toast.error(`Failed to disconnect Slack: ${error.message}`),
    }),
  );
  const startGoogle = useMutation(
    orpc.project.integrations.startGoogleOAuthFlow.mutationOptions({
      onSuccess: (result) => {
        window.location.href = result.authorizationUrl;
      },
      onError: (error) => toast.error(`Failed to connect Google: ${error.message}`),
    }),
  );
  const disconnectGoogle = useMutation(
    orpc.project.integrations.disconnectGoogle.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: googleQuery.queryKey });
        toast.success("Google disconnected");
      },
      onError: (error) => toast.error(`Failed to disconnect Google: ${error.message}`),
    }),
  );

  return (
    <section className="max-w-md space-y-4 p-4">
      <ItemGroup className="space-y-3">
        <Item variant="outline" className="items-start justify-between gap-4 p-4">
          <ItemMedia variant="icon">
            <MessageSquare className="size-4" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>Slack</ItemTitle>
            <ItemDescription>
              {slackConnection?.connected
                ? `Connected to ${slackConnection.displayName ?? slackConnection.externalId}`
                : "Connect a Slack workspace to receive project webhooks and use Slack API tools."}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {slackConnection?.connected ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disconnectSlack.isPending}
                onClick={() => disconnectSlack.mutate({ projectSlugOrId })}
              >
                {disconnectSlack.isPending ? <Spinner /> : null}
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={startSlack.isPending}
                onClick={() =>
                  startSlack.mutate({
                    projectSlugOrId,
                    callbackUrl: window.location.href,
                  })
                }
              >
                {startSlack.isPending ? <Spinner /> : null}
                Connect Slack
              </Button>
            )}
          </ItemActions>
        </Item>

        <Item variant="outline" className="items-start justify-between gap-4 p-4">
          <ItemMedia variant="icon">
            <Mail className="size-4" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>Google</ItemTitle>
            <ItemDescription>
              {googleConnection?.connected
                ? `Connected as ${googleConnection.displayName ?? googleConnection.externalId}`
                : "Connect Google for Gmail, Calendar, Docs, Sheets, and Drive API tools."}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {googleConnection?.connected ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disconnectGoogle.isPending}
                onClick={() => disconnectGoogle.mutate({ projectSlugOrId })}
              >
                {disconnectGoogle.isPending ? <Spinner /> : null}
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={startGoogle.isPending}
                onClick={() =>
                  startGoogle.mutate({
                    projectSlugOrId,
                    callbackUrl: window.location.href,
                  })
                }
              >
                {startGoogle.isPending ? <Spinner /> : null}
                Connect Google
              </Button>
            )}
          </ItemActions>
        </Item>
      </ItemGroup>
    </section>
  );
}
