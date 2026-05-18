import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectIntegrationConnection } from "@iterate-com/os-contract";
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
import { Circle, Mail, MessageSquare } from "lucide-react";
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
            <IntegrationMetadata connection={slackConnection} provider="slack" />
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
            <IntegrationMetadata connection={googleConnection} provider="google" />
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

function IntegrationMetadata({
  connection,
  provider,
}: {
  connection?: ProjectIntegrationConnection;
  provider: "google" | "slack";
}) {
  if (!connection?.connected) return null;

  const token = connection.token;
  const scopeCount = countScopes(connection.scopes, provider === "slack" ? "," : " ");
  const expiry = token?.expiresAt ? formatExpiry(token.expiresAt) : null;

  return (
    <div className="mt-2 grid gap-1.5 text-xs text-muted-foreground">
      {expiry ? (
        <IntegrationMetadataRow label="Token expiry" value={expiry.label} tone={expiry.tone} />
      ) : (
        <IntegrationMetadataRow label="Token expiry" value="Not provided" />
      )}
      <IntegrationMetadataRow
        label="Access token"
        value={token?.hasMaterial ? "Stored" : "Missing"}
        tone={token?.hasMaterial ? "ok" : "danger"}
      />
      {provider === "google" || token?.refreshTokenStored ? (
        <IntegrationMetadataRow
          label="Refresh token"
          value={token?.refreshTokenStored ? "Stored" : "Not stored"}
          tone={provider === "google" && token?.refreshTokenStored ? "ok" : undefined}
        />
      ) : null}
      {token?.createdAt ? (
        <IntegrationMetadataRow label="Secret created" value={formatTimestamp(token.createdAt)} />
      ) : null}
      {token?.updatedAt ? (
        <IntegrationMetadataRow label="Secret updated" value={formatTimestamp(token.updatedAt)} />
      ) : null}
      <IntegrationMetadataRow label="External ID" value={connection.externalId ?? "Unknown"} />
      <IntegrationMetadataRow
        label="Scopes"
        value={scopeCount === 1 ? "1 scope" : `${scopeCount} scopes`}
      />
    </div>
  );
}

function IntegrationMetadataRow({
  label,
  tone,
  value,
}: {
  label: string;
  tone?: "danger" | "ok" | "warning";
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Circle className={`size-2 shrink-0 fill-current ${toneClassName(tone)}`} />
      <span className="shrink-0 text-muted-foreground/80">{label}</span>
      <span className="truncate text-foreground">{value}</span>
    </div>
  );
}

function toneClassName(tone: "danger" | "ok" | "warning" | undefined) {
  if (tone === "danger") return "text-destructive";
  if (tone === "ok") return "text-emerald-600";
  if (tone === "warning") return "text-amber-600";
  return "text-muted-foreground/50";
}

function formatExpiry(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return { label: value, tone: undefined };
  }

  const now = Date.now();
  const prefix = timestamp <= now ? "Expired" : "Expires";
  const tone: "danger" | "ok" | "warning" =
    timestamp <= now ? "danger" : timestamp - now < 10 * 60 * 1000 ? "warning" : "ok";
  return {
    label: `${prefix} ${formatTimestamp(value)}`,
    tone,
  };
}

function formatTimestamp(value: string) {
  const timestamp = Date.parse(value.endsWith("Z") || value.includes("T") ? value : `${value}Z`);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function countScopes(scopes: string | null, separator: "," | " ") {
  if (!scopes) return 0;
  return scopes
    .split(separator)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0).length;
}
